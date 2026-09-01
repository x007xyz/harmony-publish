#!/usr/bin/env node
/**
 * create-agreement.mjs — 一次性完整执行：为 AGC 应用创建华为云托管隐私协议
 *
 * 通过 Playwriter 连接用户**正在运行的 Chrome**（保留 developer.huawei.com 登录态），
 * 全流程自动完成，无需 LLM 逐步确认。所有参数由 AI 在执行前通过 generate-copy.mjs
 * 预生成（或人工编写）到 copy JSON。
 *
 * 用法:
 *   node create-agreement.mjs --project <key|路径> --copy <copy.json> [--force] [--timeout <ms>]
 *
 *   --copy   必填。文案参数文件（字段见 generate-copy.mjs 输出）。
 *   --force  若协议列表已存在同名协议，先删除再新建（默认：已存在则跳过并输出已有信息）。
 *
 * 流程:
 *   连接 Playwriter relay → 打开 AGC 协议页 → 检测已有同名协议（可选删除）
 *   → 新建协议（类型切「隐私政策」→ 填名称）→ 编辑器填写全部字段
 *   → 添加商务联系（邮箱）→ 生成协议 → 提交确认 → 验证并输出 agreementId/托管链接
 *
 * 前置条件:
 *   - Chrome 已安装 Playwriter 扩展并已在目标 tab 点击图标连接（图标变绿）
 *   - Chrome 已登录 developer.huawei.com
 *
 * 输出:
 *   stdout JSON { ok, agreementId, name, url, status }
 *   并写入 <projectRoot>/release/privacy-agreement-result.json
 */
import { chromium } from "playwright-core";
import { startPlayWriterCDPRelayServer, getCdpUrl } from "playwriter";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "../..");
const PROJECTS = join(SKILL_DIR, "projects.json");
const AGC_HOME =
  "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html";
const PROTOCOL_ROUTE = "172249065902862722";
const DEFAULT_TIMEOUT = 60000;

// ---------------------------------------------------------------- args
function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

const projectArg = arg("--project");
const copyArg = arg("--copy");
const force = process.argv.includes("--force");
const timeout = Number(arg("--timeout", String(DEFAULT_TIMEOUT)));

if (!projectArg || !copyArg) {
  console.error(
    "usage: node create-agreement.mjs --project <key|路径> --copy <copy.json> [--force]"
  );
  process.exit(2);
}

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function loadProjects() {
  return JSON.parse(readFileSync(PROJECTS, "utf8"));
}

function resolveProject(key) {
  const projects = loadProjects();
  if (projects[key]) return { key, cfg: projects[key] };
  for (const [k, v] of Object.entries(projects)) {
    if (v.projectRoot === key || v.displayName === key) return { key: k, cfg: v };
  }
  throw new Error(`project not found in ${PROJECTS}: ${key}`);
}

function declaredPermissions(cfg) {
  const modulePath = join(cfg.projectRoot, "entry", "src", "main", "module.json5");
  try {
    const text = readFileSync(modulePath, "utf8");
    return [...text.matchAll(/"name"\s*:\s*"((?:ohos\.permission\.)[A-Z_.0-9]+)"/g)]
      .map((m) => m[1])
      .filter((n) => n !== "ohos.permission.INTERNET");
  } catch {
    return [];
  }
}

const { key: projectKey, cfg } = resolveProject(projectArg);
const appId = cfg.appId;
if (!appId) throw new Error(`project ${projectKey} has no appId in projects.json`);

const copy = JSON.parse(readFileSync(resolve(copyArg), "utf8"));
for (const field of ["name", "intro", "path", "functions", "server", "contact", "email"]) {
  if (copy[field] === undefined) throw new Error(`copy JSON missing field: ${field}`);
}
if (!String(copy.email).includes("@")) throw new Error(`invalid contact email: ${copy.email}`);

const sensitive = declaredPermissions(cfg);

async function getFrame(page) {
  await page
    .frameLocator("#mainIframeView")
    .locator("body")
    .waitFor({ timeout })
    .catch(() => {});
  return page.frames().find((f) => f.url().includes("distribute")) || null;
}

async function bodyText(frame) {
  if (!frame) return "";
  return clean(await frame.evaluate(() => document.body?.innerText || ""));
}

async function dumpState(page, label) {
  try {
    const frame = await getFrame(page);
    const text = await bodyText(frame);
    console.error(`[${label}] page state:`, text.slice(0, 1200));
  } catch {
    console.error(`[${label}] (frame unavailable)`);
  }
}

async function connectRelay() {
  try {
    return await chromium.connectOverCDP(getCdpUrl());
  } catch {
    await startPlayWriterCDPRelayServer({ port: 19988 });
    await sleep(800);
    return await chromium.connectOverCDP(getCdpUrl());
  }
}

// ---------------------------------------------------------------- main flow
async function main() {
  if (sensitive.length > 0) {
    console.warn(
      `[warn] module.json5 declares sensitive permissions: ${sensitive.join(", ")}。` +
        "脚本不会自动勾选权限声明；如协议需声明这些权限，请在生成后于 AGC 控制台手动补充（或后续扩展脚本）。"
    );
  }

  // 1. 连接 Playwriter relay（复用已运行的 server）
  const browser = await connectRelay();
  let context;
  try {
    context = browser.contexts()[0] || (await browser.newContext());
    const probe = await context.newPage(); // 探测扩展是否连接
    await probe.close();
  } catch (e) {
    throw new Error(
      "Playwriter 扩展未连接：请在 Chrome 中点击 Playwriter 扩展图标（目标 tab 图标变绿）后重试。\n" + e.message
    );
  }

  const page = await context.newPage();
  try {
    // 2. 打开协议页
    await page.goto(`${AGC_HOME}#/myApp/${appId}/${PROTOCOL_ROUTE}`, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    await sleep(4000);
    const fl = page.frameLocator("#mainIframeView");
    let frame = await getFrame(page);
    if (!frame) throw new Error("AGC 协议页 iframe 未加载（登录态可能失效，请先在 Chrome 中登录 developer.huawei.com）");

    // 3. 检测已有同名协议
    let text = await bodyText(frame);
    let existing = text.includes(copy.name);
    if (existing && !force) {
      const row = await frame.evaluate((name) => {
        const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const r = Array.from(document.querySelectorAll("tr")).find((n) =>
          cleanV(n.innerText).includes(name)
        );
        return r ? cleanV(r.innerText) : null;
      }, copy.name);
      console.error(`[skip] 协议「${copy.name}」已存在（用 --force 可删除重建）`);
      console.log(
        JSON.stringify(
          { ok: false, reason: "already_exists", row: row ? row.slice(0, 400) : null },
          null,
          2
        )
      );
      return;
    }
    if (existing && force) {
      console.error("[force] 删除已有同名协议…");
      await fl
        .locator("tr", { hasText: copy.name })
        .getByText("删除", { exact: true })
        .first()
        .click();
      await sleep(2000);
      const confirmBox = fl.locator(".el-message-box, [role=dialog]").last();
      const confirmBtn = confirmBox
        .getByRole("button", { name: /^(确认|确定)$/ })
        .first();
      await confirmBtn.click({ timeout: 15000 }).catch(async () => {
        throw new Error("删除确认弹窗未出现");
      });
      await sleep(2500);
      text = await bodyText(frame);
      if (text.includes(copy.name)) {
        throw new Error("删除已有协议失败（列表中仍存在同名协议）");
      }
      console.error("[force] 已删除，继续新建…");
    }

    // 4. 新建协议
    await fl.getByText("新建协议", { exact: true }).first().click();
    await sleep(2000);
    const dialog = fl.locator("[role=dialog]", { hasText: "新建协议" }).first();
    await dialog.waitFor({ timeout: 20000 }).catch(async () => {
      await dumpState(page, "new-dialog");
      throw new Error("「新建协议」对话框未出现");
    });

    // 4a. 协议类型 → 隐私政策（默认是「用户协议」，必须切换）
    await dialog.locator(".el-select").first().click();
    await sleep(1500);
    await fl
      .locator(".el-select-dropdown__item, li[role=option]", { hasText: "隐私政策" })
      .first()
      .click();
    await sleep(1200);
    const dialogText = clean(await dialog.innerText());
    if (!dialogText.includes("隐私政策")) {
      await dumpState(page, "type-switch");
      throw new Error("协议类型切换为「隐私政策」失败");
    }

    // 4b. 协议名称
    await dialog.locator("input[maxlength=\"100\"]").first().fill(copy.name);
    await sleep(500);
    if ((await dialog.locator("input[maxlength=\"100\"]").first().inputValue()) !== copy.name) {
      throw new Error("协议名称填写失败");
    }

    // 4c. 下一步 → 编辑器
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await sleep(4000);
    await fl.locator("input[placeholder=\"产品简介\"]").waitFor({ timeout: 25000 }).catch(async () => {
      await dumpState(page, "editor-open");
      throw new Error("协议编辑器未打开");
    });

    // 5. 编辑器字段
    // 5a. 产品简介 + 服务模式路径
    await fl.locator("input[placeholder=\"产品简介\"]").fill(copy.intro);
    await fl
      .locator("input[placeholder=\"请输入应用内服务模式设置页面路径\"]")
      .first()
      .fill(copy.path);
    await sleep(800);

    // 5b. 服务模式 → 不收集个人信息（combobox 第 2 个）
    await fl
      .locator("input[role=combobox]")
      .nth(1)
      .evaluate((el) =>
        el.closest(".el-select")?.querySelector(".el-select__wrapper")?.click()
      );
    await sleep(1500);
    const modeOption = fl
      .locator(".el-select-dropdown__item, li[role=option]", { hasText: copy.mode })
      .first();
    await modeOption.click().catch(async () => {
      await dumpState(page, "mode-select");
      throw new Error(`服务模式选项「${copy.mode}」不可用`);
    });
    await sleep(1200);

    // 5c. 产品功能（编辑器可用 ≤2 项）
    const funcFields = fl.locator("input[placeholder=\"请输入产品功能\"]");
    for (let i = 0; i < Math.min(copy.functions.length, 2); i++) {
      const f = funcFields.nth(i);
      if (await f.isDisabled().catch(() => true)) break;
      await f.fill(copy.functions[i]);
    }
    await sleep(600);

    // 5d. 存储期限 → 最短必要时间（radio value=-1，第 2 个）
    await fl
      .locator("input[type=radio]")
      .nth(1)
      .evaluate((el) => (el.closest("label") || el.closest(".el-radio") || el).click());
    await sleep(1000);
    const minRadioChecked = await fl
      .locator("input[type=radio]")
      .nth(1)
      .isChecked()
      .catch(() => false);
    if (!minRadioChecked) throw new Error("存储期限「最短必要时间」勾选失败");

    // 5e. 服务器位置 + 自定义联系
    await fl.locator("input[placeholder^=\"服务器所在国家\"]").first().fill(copy.server);
    await fl.locator("textarea[placeholder=\"请输入自定义内容\"]").first().fill(copy.contact);
    await sleep(800);

    // 6. 商务联系（#addBusinessLinkId → 邮箱 + email）
    await fl.locator("#addBusinessLinkId").first().click();
    await sleep(1800);
    await fl.locator("#addBusinessLinkId").evaluate((el) => {
      const area = el.parentElement;
      const rows = Array.from(area?.querySelectorAll(".cs-flex-start-center") || [])
        .filter((n) => n.querySelector(".el-select") && n.querySelector("input:not([role=combobox])"));
      rows.at(-1)?.querySelector(".el-select__wrapper")?.click();
    });
    await sleep(1500);
    await fl
      .locator(".el-select-dropdown__item, li[role=option]", { hasText: "邮箱" })
      .last()
      .click();
    await sleep(1200);
    frame = await getFrame(page);
    const emailSet = await frame.evaluate((email) => {
      const area = document.querySelector("#addBusinessLinkId")?.parentElement;
      const rows = Array.from(area?.querySelectorAll(".cs-flex-start-center") || [])
        .filter((n) => n.querySelector(".el-select") && n.querySelector("input:not([role=combobox])"));
      const input = rows.at(-1)?.querySelector("input:not([role=combobox])");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      if (setter) setter.call(input, email);
      else input.value = email;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, copy.email);
    if (!emailSet) throw new Error("商务联系邮箱输入框未找到");
    await sleep(1000);

    // 7. 生成协议
    await fl.getByText("生成协议", { exact: true }).first().click();
    await sleep(4000);
    const successDialog = fl.locator("[role=dialog]", { hasText: "提交成功" }).first();
    await successDialog.waitFor({ timeout: 30000 }).catch(async () => {
      await dumpState(page, "submit");
      throw new Error("生成协议未返回「提交成功」（请查看上方页面状态）");
    });
    const confirmBtns = successDialog.getByRole("button", { name: "确认", exact: true });
    await confirmBtns.first().click();
    await sleep(3000);

    // 7b. 点击编辑器顶部「保存」持久化草稿
    const saveBtn = fl.locator("button", { hasText: "保存", exact: true }).first();
    if (await saveBtn.count() > 0) {
      const saveDisabled = await saveBtn.isDisabled().catch(() => true);
      if (!saveDisabled) {
        await saveBtn.click();
        await sleep(3000);
        const savedDialog = fl.locator(".el-message-box, [role=dialog]", { hasText: /保存成功/ }).first();
        if (await savedDialog.count() > 0) {
          await savedDialog.getByRole("button", { name: /^(确认|确定)$/ }).first().click().catch(() => {});
          await sleep(1500);
        }
      }
    }

    // 8. 验证列表中的新协议
    frame = await getFrame(page);
    text = await bodyText(frame);
    if (!text.includes(copy.name)) {
      await dumpState(page, "verify");
      throw new Error("协议列表中未出现新协议「" + copy.name + "」");
    }
    const row = await frame.evaluate((name) => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const r = Array.from(document.querySelectorAll("tr")).find((n) =>
        cleanV(n.innerText).includes(name)
      );
      return r ? cleanV(r.innerText) : null;
    }, copy.name);
    const agreementId = row?.match(/\d{16,}/)?.[0] || "";
    const url = row?.match(/https:\/\/agreement-[^\s]+/)?.[0] || "";
    const status = row?.match(/(完成|草稿|审核中|已下架)/)?.[1] || "";

    const result = {
      ok: true,
      project: projectKey,
      agreementId,
      name: copy.name,
      url,
      status,
      createdAt: new Date().toISOString(),
    };
    const outPath = join(cfg.projectRoot, "release", "privacy-agreement-result.json");
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    console.error(`result saved to ${outPath}`);
  } catch (e) {
    await dumpState(page, "error").catch(() => {});
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
  });
