#!/usr/bin/env node
/**
 * create-app-id.mjs — 一次性完整执行：在 AGC 创建 HarmonyOS APP ID
 *
 * 通过 Playwriter 连接用户**正在运行的 Chrome**（保留 developer.huawei.com 登录态），
 * 全流程自动完成。参数由 AI 在执行前预生成（projects.json 或 --args）。
 *
 * 用法:
 *   node create-app-id.mjs --project <key> [--app-name <名称>] [--bundle-name <包名>]
 *                          [--project-name <项目名>] [--capabilities <能力,能力>]
 *
 *   --project       必填。projects.json key；也可传项目路径（此时需显式提供
 *                   --app-name/--bundle-name/--project-name）。
 *   --capabilities  可选。逗号分隔的开放能力名；默认全部不勾选。
 *
 * 流程:
 *   打开 AGC APP ID 列表 → 若包名已存在则跳过(输出已有 appId)
 *   → 新建 → 填应用名称/包名/分类 → 下一步
 *   → 应用所属项目(输入新项目名 → 确认,轮询等待项目创建完成)
 *   → 开放能力页(默认不勾选,轮询保存按钮可用后保存)
 *   → 回到列表验证,输出 appId
 *
 * 前置条件: Chrome 已装 Playwriter 扩展并连接、已登录 developer.huawei.com。
 */
import { chromium } from "playwright-core";
import { startPlayWriterCDPRelayServer, getCdpUrl } from "playwriter";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "../..");
const PROJECTS = join(SKILL_DIR, "projects.json");
const AGC_APP_ID_URL =
  "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html#/harmonyOSDevPlatform/172249065903274453";
const TIMEOUT = 60000;

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

const projectArg = arg("--project");
if (!projectArg) {
  console.error("usage: node create-app-id.mjs --project <key> [--app-name] [--bundle-name] [--project-name] [--capabilities]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

let cfg = null;
try {
  const projects = JSON.parse(readFileSync(PROJECTS, "utf8"));
  cfg = projects[projectArg] ||
    Object.values(projects).find((v) => v.projectRoot === projectArg || v.displayName === projectArg);
} catch {}
if (!cfg) cfg = { projectRoot: projectArg, appName: "", bundleName: "", agcProjectName: "" };

const appName = String(arg("--app-name") || cfg.appName || "").trim();
const bundleName = String(arg("--bundle-name") || cfg.bundleName || "").trim();
const projectName = String(arg("--project-name") || cfg.agcProjectName || "").trim();
const capabilitiesRequested = String(arg("--capabilities") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!appName || !bundleName) {
  console.error("Missing app name or bundle name (provide via --app-name/--bundle-name or projects.json entry)");
  process.exit(2);
}
if (!projectName) {
  console.error("Missing AGC project name (provide via --project-name or projects.json agcProjectName)");
  process.exit(2);
}

async function getFrame(page, pattern) {
  await page
    .frameLocator("#mainIframeView")
    .locator("body")
    .waitFor({ timeout: TIMEOUT })
    .catch(() => {});
  return page.frames().find((f) => pattern.test(f.url())) || null;
}

async function dismissKnow(page) {
  const fl = page.frameLocator("#mainIframeView");
  const ok = fl.locator("button", { hasText: "知道了" }).first();
  if (await ok.count().catch(() => 0) > 0) {
    await ok.click().catch(() => {});
    await sleep(1200);
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

async function main() {
  const browser = await connectRelay();
  let context;
  try {
    context = browser.contexts()[0] || (await browser.newContext());
    const probe = await context.newPage();
    await probe.close();
  } catch (e) {
    throw new Error(
      "Playwriter 扩展未连接：请在 Chrome 中点击 Playwriter 扩展图标（目标 tab 图标变绿）后重试。\n" + e.message
    );
  }

  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  try {
    // 1. APP ID 列表页（轮询等待 iframe 加载;若停在主布局则点菜单「APP ID」）
    await page.goto(AGC_APP_ID_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(6000);
    await dismissKnow(page);
    let frame = null;
    for (let i = 0; i < 5; i++) {
      frame = page.frames().find((f) => f.url().includes("appIdManageList")) || null;
      if (frame) break;
      await sleep(3000);
    }
    if (!frame) {
      const shell = await getFrame(page, /agc/);
      const clicked = await shell?.evaluate(() => {
        const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const item = Array.from(document.querySelectorAll("li.el-menu-item"))
          .find((n) => cleanV(n.innerText || n.textContent) === "APP ID");
        if (!item) return false;
        item.click();
        return true;
      }).catch(() => false);
      if (!clicked) throw new Error("APP ID 菜单不可用");
      await sleep(5000);
      frame = page.frames().find((f) => f.url().includes("appIdManageList")) || null;
    }
    if (!frame) throw new Error("无法进入 APP ID 列表（请检查是否已登录）");

    // 2. 幂等检查：包名已存在 → 跳过
    const listText = clean(await frame.evaluate(() => document.body?.innerText || ""));
    if (listText.includes(bundleName)) {
      const row = await frame.evaluate((b) => {
        const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const r = Array.from(document.querySelectorAll("tr")).find((n) => cleanV(n.innerText).includes(b));
        return r ? cleanV(r.innerText) : null;
      }, bundleName);
      console.log(JSON.stringify({
        ok: true,
        reason: "already_exists",
        project: projectArg,
        bundleName,
        row: row ? row.slice(0, 300) : null,
      }, null, 2));
      return;
    }

    // 3. 新建
    const listFrame = frame;
    await listFrame.locator("button", { hasText: "新建", exact: true }).first().click();
    await sleep(4000);
    frame = await getFrame(page, /anageCreate|appIdManageCreate/);
    if (!frame) throw new Error("APP ID 创建页未打开");
    const fl = page.frameLocator("#mainIframeView");

    // 4. 第一步：应用名称/包名/分类
    await fl.locator("input[placeholder=\"请填写新应用名称（限30字符）\"]").first().fill(appName);
    await fl.locator("input[placeholder=\"应用包名应为7-128字符\"]").first().fill(bundleName);
    const categoryPicked = await frame.evaluate(() => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const input = Array.from(document.querySelectorAll("input[type=radio]"))
        .find((n) => cleanV(n.closest("label,li,div")?.innerText) === "应用" && n.value === "13");
      if (!input || input.checked) return input ? "already" : "not_found";
      (input.closest("label") || input.closest(".el-radio") || input).click();
      return "picked";
    });
    if (categoryPicked === "not_found") throw new Error("应用分类「应用」选项不可用");
    await sleep(1000);
    await fl.locator("button", { hasText: "下一步", exact: true }).first().click();
    await sleep(3500);

    // 包名冲突检测（后端校验）
    const conflictWarn = fl.locator(".el-message-box", { hasText: "已经存在" }).first();
    if (await conflictWarn.count() > 0) {
      console.log(JSON.stringify({
        ok: false,
        reason: "bundle_name_exists",
        project: projectArg,
        bundleName,
        message: "应用包名已经存在（可能已在 AGC 注册）",
      }, null, 2));
      return;
    }

    // 5. 应用所属项目：输入新项目名 → 确认（项目创建为慢异步,需充分轮询）
    const projectInput = fl.locator("input[type=text][aria-autocomplete=list]").first();
    await projectInput.waitFor({ timeout: 20000 }).catch(() => {
      throw new Error("应用所属项目输入框未出现");
    });
    await projectInput.fill(projectName);
    await sleep(1500);
    await projectInput.press("Enter");
    await sleep(1500);
    const confirmBtn = fl.locator("button", { hasText: "确认", exact: true }).first();
    let confirmReady = false;
    for (let i = 0; i < 6; i++) {
      await sleep(2500);
      const disabled = await confirmBtn.isDisabled().catch(() => true);
      if (!disabled) { confirmReady = true; break; }
    }
    if (!confirmReady) {
      console.error("[warn] 确认按钮未在 15s 内启用,重新输入项目名重试");
      await projectInput.evaluate((el) => el.removeAttribute("disabled")).catch(() => {});
      await projectInput.fill(projectName);
      await sleep(1000);
      await projectInput.press("Enter");
      await sleep(2500);
    }
    await confirmBtn.click({ timeout: 15000 }).catch(async () => {
      throw new Error("「确认」按钮点击失败");
    });
    await sleep(5000);

    // 6. 开放能力页：轮询保存按钮可用（项目创建异步,上限 90s）。
    //    注意:即使保存按钮未启用,后端可能已创建 APP ID —— 超时后回列表验证,
    //    以列表出现为准。
    const saveBtn = fl.locator("button", { hasText: "保存", exact: true }).first();
    let saveReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const disabled = await saveBtn.isDisabled().catch(() => true);
      if (!disabled) { saveReady = true; break; }
    }
    if (!saveReady) {
      console.error("[warn] 保存按钮 90s 内未启用;后端可能已创建,将回列表验证");
    } else {
      // 7. 勾选请求的能力（默认全部不勾选）
      for (const name of capabilitiesRequested) {
        const picked = await frame.evaluate((wanted) => {
          const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
          const row = Array.from(document.querySelectorAll("tr, [class*=row], [class*=card], section"))
            .find((n) => /了解详情/.test(n.innerText || "") && cleanV(n.innerText).split("了解详情")[0].trim() === wanted);
          const checkbox = row?.querySelector("input[type=checkbox], .el-switch input");
          if (!checkbox || checkbox.checked) return false;
          (checkbox.closest("label") || checkbox.closest(".el-checkbox") || checkbox).click();
          return true;
        }, name);
        if (!picked) console.error(`[warn] 开放能力「${name}」未找到或已勾选`);
        await sleep(800);
      }
      // 8. 保存
      await saveBtn.click({ timeout: 15000 }).catch(async () => {
        console.error("[warn] 「保存」按钮点击失败,将回列表验证");
      });
      await sleep(6000);
    }

    // 9. 验证：回到列表出现 bundleName（轮询等待）
    await page.goto(AGC_APP_ID_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(6000);
    await dismissKnow(page);
    let verifyFrame = null;
    for (let i = 0; i < 5; i++) {
      verifyFrame = page.frames().find((f) => f.url().includes("appIdManageList")) || null;
      if (verifyFrame) break;
      await sleep(3000);
    }
    const finalText = verifyFrame
      ? clean(await verifyFrame.evaluate(() => document.body?.innerText || ""))
      : "";
    const row = verifyFrame ? await verifyFrame.evaluate((b) => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const r = Array.from(document.querySelectorAll("tr")).find((n) => cleanV(n.innerText).includes(b));
      return r ? cleanV(r.innerText) : null;
    }, bundleName) : null;
    const appId = row?.match(/\d{16,}/)?.[0] || "";

    if (!row) {
      throw new Error(`保存后列表未出现 ${bundleName}（请检查 AGC 控制台）`);
    }
    const result = {
      ok: true,
      project: projectArg,
      appId,
      appName,
      bundleName,
      projectName,
      capabilities: capabilitiesRequested,
      createdAt: new Date().toISOString(),
    };
    const outPath = join(cfg.projectRoot || projectArg, "release", "app-id-result.json");
    try {
      writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
      console.error(`result saved to ${outPath}`);
    } catch {}
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    try {
      const f = await getFrame(page, /agc/);
      if (f) console.error("[state]", clean(await f.evaluate(() => document.body?.innerText || "")).slice(0, 900));
    } catch {}
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
