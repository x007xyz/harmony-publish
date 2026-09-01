#!/usr/bin/env python3
"""Inspect or set quoted or unquoted HarmonyOS JSON5 version fields."""

from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path


VERSION_CODE = re.compile(
    r'(?m)^(\s*(?:"versionCode"|versionCode)\s*:\s*)(\d+)(\s*,?\s*)$'
)
VERSION_NAME = re.compile(
    r'''(?m)^(\s*(?:"versionName"|versionName)\s*:\s*)(["'])([^"']*)(\2\s*,?\s*)$'''
)


def read_versions(path: Path) -> tuple[int, str, str]:
    text = path.read_text(encoding="utf-8")
    code = VERSION_CODE.search(text)
    name = VERSION_NAME.search(text)
    if not code or not name:
        raise ValueError(f"versionCode/versionName not found in {path}")
    return int(code.group(2)), name.group(3), text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("action", choices=["check", "set"])
    parser.add_argument("--version-code", type=int)
    parser.add_argument("--version-name")
    args = parser.parse_args()

    app_json = args.project.expanduser().resolve() / "AppScope" / "app.json5"
    if not app_json.is_file():
        raise ValueError(f"missing HarmonyOS app config: {app_json}")
    old_code, old_name, text = read_versions(app_json)
    if args.action == "check":
        print(f"versionCode={old_code}")
        print(f"versionName={old_name}")
        return 0

    if args.version_code is None or not args.version_name:
        raise ValueError("set requires --version-code and --version-name")
    if args.version_code <= old_code:
        raise ValueError(f"new versionCode must exceed {old_code}")
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]{0,63}", args.version_name):
        raise ValueError("versionName has an unsupported format")

    updated = VERSION_CODE.sub(rf"\g<1>{args.version_code}\g<3>", text, count=1)
    updated = VERSION_NAME.sub(
        lambda match: (
            f"{match.group(1)}{match.group(2)}{args.version_name}{match.group(4)}"
        ),
        updated,
        count=1,
    )
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=app_json.parent,
        prefix=".app.json5.",
        delete=False,
    ) as handle:
        handle.write(updated)
        temp_path = Path(handle.name)
    os.replace(temp_path, app_json)
    # Flutter OHOS: the build reads the effective version from local.properties
    # (flutter-hvigor-plugin overrides app.json5 with these values).
    # local.properties 位于 ohos/ 根（args.project 指向 ohos 目录），
    # 而不是 AppScope/ 内 —— 误用 app_json.parent 会静默跳过同步，
    # 导致构建报 "HAP metadata does not match AppScope/app.json5"。
    local_props = args.project.expanduser().resolve() / "local.properties"
    if local_props.is_file():
        props_text = local_props.read_text(encoding="utf-8")
        props_text, _ = re.subn(
            r'(?m)^flutter\.versionCode\s*=.*$',
            f"flutter.versionCode={args.version_code}",
            props_text,
            count=1,
        )
        props_text, _ = re.subn(
            r'(?m)^flutter\.versionName\s*=.*$',
            f"flutter.versionName={args.version_name}",
            props_text,
            count=1,
        )
        if "flutter.versionCode" not in props_text:
            props_text += f"\nflutter.versionCode={args.version_code}\n"
        if "flutter.versionName" not in props_text:
            props_text += f"flutter.versionName={args.version_name}\n"
        local_props.write_text(props_text, encoding="utf-8")
        print(f"local.properties={args.version_code}/{args.version_name} synced")
    print(f"versionCode={old_code}->{args.version_code}")
    print(f"versionName={old_name}->{args.version_name}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(f"error: {error}")
        raise SystemExit(2)
