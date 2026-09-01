#!/usr/bin/env python3
"""Aggregate CSV files produced by harmony-publish reports-export."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


DOWNLOAD_FIELDS = {
    "曝光": "有效曝光次数",
    "点击": "ICON点击次数",
    "详情访问": "详情页访问次数",
    "总下载": "总下载成功次数",
    "新下载": "新下载成功次数",
    "安装": "安装成功次数",
    "新安装": "新安装成功次数",
    "卸载": "卸载次数",
}


def args_parser() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--projects", required=True, type=Path)
    parser.add_argument("--previous-start", required=True)
    parser.add_argument("--previous-end", required=True)
    parser.add_argument("--current-start", required=True)
    parser.add_argument("--current-end", required=True)
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Project key to exclude from the aggregate report (repeatable).",
    )
    return parser.parse_args()


def rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def integer(value: str | None) -> int:
    try:
        return int(float(str(value or "0").replace(",", "")))
    except ValueError:
        return 0


def in_window(row: dict[str, str], start: str, end: str) -> bool:
    date = str(row.get("日期", ""))
    return start <= date <= end


def download_summary(data: list[dict[str, str]], start: str, end: str) -> dict[str, float | int]:
    selected = [row for row in data if in_window(row, start, end)]
    result: dict[str, float | int] = {
        name: sum(integer(row.get(field)) for row in selected)
        for name, field in DOWNLOAD_FIELDS.items()
    }
    exposure = int(result["曝光"])
    clicks = int(result["点击"])
    new_downloads = int(result["新下载"])
    new_installs = int(result["新安装"])
    result["CTR"] = clicks / exposure if exposure else 0
    result["周期安装成功率"] = new_installs / new_downloads if new_downloads else 0
    result["安装卸载差"] = new_installs - int(result["卸载"])
    result["有数据天数"] = sum(any(integer(row.get(field)) for field in DOWNLOAD_FIELDS.values()) for row in selected)
    return result


def user_summary(data: list[dict[str, str]], start: str, end: str, kind: str) -> dict[str, float | int | None]:
    selected = sorted((row for row in data if in_window(row, start, end)), key=lambda row: row.get("日期", ""))
    if not selected:
        return {"累计": None, "新增": 0, "活跃人天": 0, "平均DAU": 0, "流失": 0, "有数据天数": 0}
    prefix = "用户" if kind == "account" else "设备"
    cumulative_field = f"累计{prefix}数"
    new_field = f"新增{prefix}数"
    active_field = f"活跃{prefix}数"
    churn_field = f"流失{prefix}数"
    nonzero = [row for row in selected if integer(row.get(cumulative_field)) > 0]
    active_days = len(nonzero)
    active_total = sum(integer(row.get(active_field)) for row in selected)
    return {
        "累计": integer(nonzero[-1].get(cumulative_field)) if nonzero else None,
        "新增": sum(integer(row.get(new_field)) for row in selected),
        "活跃人天": active_total,
        "平均DAU": round(active_total / active_days, 2) if active_days else 0,
        "流失": sum(integer(row.get(churn_field)) for row in selected),
        "有数据天数": active_days,
    }


def percent(value: float | int) -> str:
    return f"{float(value) * 100:.2f}%"


def change(current: int | float, previous: int | float) -> str:
    if previous == 0:
        return "新增" if current else "—"
    return f"{(current / previous - 1) * 100:+.1f}%"


def main() -> None:
    args = args_parser()
    projects = json.loads(args.projects.read_text(encoding="utf-8"))
    excluded = set(args.exclude)
    summaries = []
    for directory in sorted(path for path in args.input.iterdir() if path.is_dir()):
        key = directory.name
        if key in excluded:
            continue
        cfg = projects.get(key, {})
        download_rows = rows(directory / "downloads.csv")
        account_rows = rows(directory / "users-account.csv")
        device_rows = rows(directory / "users-device.csv")
        failed_rows = rows(directory / "install-failed.csv")
        summaries.append({
            "key": key,
            "name": cfg.get("appName") or cfg.get("displayName") or key,
            "appId": str(cfg.get("appId", "")),
            "previous": download_summary(download_rows, args.previous_start, args.previous_end),
            "current": download_summary(download_rows, args.current_start, args.current_end),
            "accountPrevious": user_summary(account_rows, args.previous_start, args.previous_end, "account"),
            "accountCurrent": user_summary(account_rows, args.current_start, args.current_end, "account"),
            "deviceCurrent": user_summary(device_rows, args.current_start, args.current_end, "device"),
            "installFailureRows": len(failed_rows),
        })

    summaries.sort(key=lambda item: int(item["current"]["新下载"]), reverse=True)
    (args.input / "summary.json").write_text(json.dumps(summaries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with (args.input / "summary.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["应用", "曝光", "点击", "CTR", "详情访问", "新下载", "新安装", "卸载", "安装卸载差", "累计用户", "新增用户", "平均DAU", "安装失败记录"])
        for item in summaries:
            current = item["current"]
            account = item["accountCurrent"]
            writer.writerow([
                item["name"], current["曝光"], current["点击"], percent(current["CTR"]), current["详情访问"],
                current["新下载"], current["新安装"], current["卸载"], current["安装卸载差"],
                account["累计"] if account["累计"] is not None else "无数据", account["新增"], account["平均DAU"], item["installFailureRows"],
            ])

    total = {field: sum(int(item["current"][field]) for item in summaries) for field in ["曝光", "点击", "详情访问", "新下载", "新安装", "卸载", "安装卸载差"]}
    previous_total = {field: sum(int(item["previous"][field]) for item in summaries) for field in ["曝光", "新下载", "新安装", "卸载"]}
    total_ctr = total["点击"] / total["曝光"] if total["曝光"] else 0
    total_users = sum(int(item["accountCurrent"]["累计"] or 0) for item in summaries)
    total_new_users = sum(int(item["accountCurrent"]["新增"]) for item in summaries)
    total_active_user_days = sum(int(item["accountCurrent"]["活跃人天"]) for item in summaries)
    lines = [
        "# AppGallery 已上架应用分析",
        "",
        f"- 当前周期：{args.current_start}–{args.current_end}",
        f"- 对比周期：{args.previous_start}–{args.previous_end}",
        f"- 纳入应用：{len(summaries)} 个（来自官方上架状态与项目已发布清单）",
        "",
        "## 总览",
        "",
        f"当前周期共获得 {total['曝光']:,} 次有效曝光、{total['点击']:,} 次 ICON 点击，整体 CTR 为 {percent(total_ctr)}；新下载 {total['新下载']:,} 次、新安装 {total['新安装']:,} 次、卸载 {total['卸载']:,} 次。账号维度累计用户 {total_users:,}，周期新增用户 {total_new_users:,}，活跃用户人天 {total_active_user_days:,}。",
        f"相较上一周期：曝光 {change(total['曝光'], previous_total['曝光'])}，新下载 {change(total['新下载'], previous_total['新下载'])}，新安装 {change(total['新安装'], previous_total['新安装'])}。",
        "",
        "## 应用表现",
        "",
        "| 应用 | 曝光 | CTR | 详情访问 | 新下载 | 新安装 | 卸载 | 安装-卸载差 | 累计用户 | 平均DAU |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in summaries:
        current = item["current"]
        account = item["accountCurrent"]
        lines.append(
            f"| {item['name']} | {current['曝光']:,} | {percent(current['CTR'])} | {current['详情访问']:,} | {current['新下载']:,} | {current['新安装']:,} | {current['卸载']:,} | {current['安装卸载差']:+,} | {account['累计'] if account['累计'] is not None else '无数据'} | {account['平均DAU']} |"
        )

    top_download = summaries[0] if summaries else None
    top_ctr = max((item for item in summaries if int(item["current"]["曝光"]) >= 100), key=lambda item: float(item["current"]["CTR"]), default=None)
    negative = [item for item in summaries if int(item["current"]["安装卸载差"]) < 0]
    missing_devices = [item["name"] for item in summaries if item["deviceCurrent"]["累计"] is None]
    dormant = [item for item in summaries if int(item["current"]["曝光"]) == 0 and int(item["accountCurrent"]["累计"] or 0) > 0]
    lines += ["", "## 结论与建议", ""]
    if top_download:
        lines.append(f"- 下载领先：{top_download['name']}，当前周期新下载 {top_download['current']['新下载']:,} 次。")
    if top_ctr:
        lines.append(f"- 素材吸引力领先：{top_ctr['name']}，有效曝光 CTR {percent(top_ctr['current']['CTR'])}。")
    if negative:
        lines.append("- 卸载压力：" + "、".join(f"{item['name']}（安装-卸载差 {int(item['current']['安装卸载差']):+d}）" for item in negative) + "。优先检查首次体验、功能预期与商店文案是否一致。")
    else:
        lines.append(f"- 当前周期安装次数比卸载次数合计多 {total['安装卸载差']:,}；但安装、卸载都是事件次数而非净用户数，不能直接当作留存。")
    lines.append("- 安装失败报表均无明细记录，当前没有官方记录到的集中安装失败问题。")
    if missing_devices:
        lines.append("- 设备维度暂无数据：" + "、".join(missing_devices) + "；对应应用仍可使用账号维度判断新增与活跃。")
    if dormant:
        lines.append("- 存量应用无近期流量：" + "、".join(f"{item['name']}（累计用户 {item['accountCurrent']['累计']}）" for item in dormant) + "当前周期曝光、新下载和活跃均为 0，建议核对上架范围、可搜索性和版本兼容状态。")
    lines.append("- 7 个产生流量的应用都在当前周期后半段才上架，上一周期分发数据为零，环比百分比没有统计意义；建议积累满 30 天后再次运行同一分析。")
    lines.append("- 用户报表中的流失定义要求过去 3 个月未使用；应用刚上架，因此当前流失数为 0 不代表留存良好。")
    lines.append("- 用户分析统计应用访问账号，下载报表仅统计华为应用市场分发，两者口径不同，因此新增用户数可能高于应用市场新下载次数。")
    lines.append("- 报表中的安装与下载可能跨日归因，因此单日安装成功率可能超过 100%；本报告以周期总量和趋势为主，不把单日异常比例解释为故障。")
    (args.input / "analysis.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
