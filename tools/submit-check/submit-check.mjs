#!/usr/bin/env node
/**
 * submit-check.mjs — 一次性执行：版本页三项必填设置 + 保存 + 必填警告校验
 *
 * 通过 Playwriter 连接用户**正在运行的 Chrome**（保留 developer.huawei.com 登录态）。
 * 发布前必须满足的版本页必填项：
 *   1. 发布国家或地区 → 所有国家或地区
 *   2. 应用内资费 → 其它（免费应用）
 *   3. 是否涉及个人信息收集 → 否
 * 全部设置后点「保存」，并校验「必填信息未填写」警告是否清除。
 *
 * 用法:
 *   node submit-check.mjs --project <key>
 *
 * 输出:
 *   { ok, project, countries, fee, privacy, changed, saved, warningCleared }
 *   幂等:三项均已设置时无改动,跳过保存。
 *
 * 前置条件: Chrome 已装 Playwriter 扩展并连接、已登录 developer.huawei.com。
 */
import { chromium } from "playwright-core";
import { startPlayWriterCDPRelayServer, getCdpUrl } from "playwriter";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "../..");
const PROJECTS = join(SKILL_DIR, "projects.json");
const VERSION_HOME =
  "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html";
const VERSION_ROUTE = "172249065903274627";
const TIMEOUT = 60000;

const projectArg = process.argv[process.argv.indexOf("--project") + 1] || "";
if (!projectArg) {
  console.error("usage: node submit-check.mjs --project <key>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

const projects = JSON.parse(readFileSync(PROJECTS, "utf8"));
const cfg = projects[projectArg] ||
  Object.values(projects).find((v) => v.projectRoot === projectArg || v.displayName === projectArg);
if (!cfg) throw new Error(`project not found in ${PROJECTS}: ${projectArg}`);
const appId = cfg.appId;
if (!appId) throw new Error(`project ${projectArg} has no appId in projects.json`);

async function getFrame(page) {
  await page
    .frameLocator("#mainIframeView")
    .locator("body")
    .waitFor({ timeout: TIMEOUT })
    .catch(() => {});
  return page.frames().find((f) => f.url().includes("distribute")) || null;
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
    await page.goto(`${VERSION_HOME}#/myApp/${appId}/${VERSION_ROUTE}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await sleep(5000);
    let menuClicked = false;
    let menuText = "";
    for (let i = 0; i < 6; i++) {
      const result = await page.evaluate(() => {
        const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const item = Array.from(document.querySelectorAll("li.el-menu-item.base-menu-item__third"))
          .find((n) => /准备提交|等待审核|审核中/.test(cleanV(n.innerText || n.textContent)));
        if (!item) return null;
        const text = cleanV(item.innerText || n.textContent);
        item.click();
        return text;
      }).catch(() => null);
      if (result) {
        menuClicked = true;
        menuText = result;
        break;
      }
      await sleep(3000);
    }
    if (!menuClicked) throw new Error("版本菜单「准备提交/等待审核」不可用");
    if (/等待审核|审核中/.test(menuText)) {
      console.log(JSON.stringify({
        ok: true,
        project: projectArg,
        alreadySubmitted: true,
        detail: `版本已提交审核（${menuText}），无需必填检查`,
      }, null, 2));
      return;
    }
    await sleep(7000);

    const fl = page.frameLocator("#mainIframeView");
    const frame = await getFrame(page);
    if (!frame) throw new Error("AGC 版本页 iframe 未加载");

    // 1. 发布国家或地区 → 所有国家或地区
    const countries = await frame.evaluate(() => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const label = Array.from(document.querySelectorAll("label, .el-radio"))
        .find((n) => /所有国家或地区/.test(cleanV(n.innerText || n.textContent)) && n.offsetWidth > 0);
      if (!label) return "not_found";
      const input = label.querySelector("input[type=radio]");
      if (input?.checked) return "already";
      label.click();
      return "picked";
    });

    // 2. 应用内资费 → 其它
    const fee = await frame.evaluate(() => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const label = Array.from(document.querySelectorAll("label.el-checkbox"))
        .find((n) => cleanV(n.innerText) === "其它" && n.offsetWidth > 0);
      if (!label) return "not_found";
      const input = label.querySelector("input");
      if (input?.checked) return "already";
      label.click();
      return "picked";
    });

    // 3. 是否涉及个人信息收集 → 否
    const privacy = await frame.evaluate(() => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const input = Array.from(document.querySelectorAll("input[type=radio]"))
        .find((n) => cleanV(n.closest("label,li,div")?.innerText) === "否" && n.value === "false" && n.offsetWidth > 0);
      if (!input || input.checked) return input ? "already" : "not_found";
      (input.closest("label") || input.closest(".el-radio") || input).click();
      return "picked";
    });

    const changed = [countries, fee, privacy].some((v) => v === "picked");
    let saved = false;
    if (changed) {
      await sleep(2000);
      const saveBtn = fl.locator("button", { hasText: "保存", exact: true }).first();
      const saveDisabled = await saveBtn.isDisabled().catch(() => true);
      if (!saveDisabled) {
        await saveBtn.click();
        await sleep(4000);
        const savedDialog = fl.locator(".el-message-box", { hasText: /保存成功/ }).first();
        if (await savedDialog.count() > 0) {
          await savedDialog.getByRole("button", { name: /^(确认|确定|知道了)$/ }).first().click().catch(() => {});
          await sleep(1500);
        }
        saved = true;
      }
    }

    // 4. 校验必填警告（重新读取页面）
    await sleep(2000);
    const text = clean(await frame.evaluate(() => document.body?.innerText || ""));
    const warningCleared = !/必填信息未填写/.test(text);

    const result = {
      ok: warningCleared,
      project: projectArg,
      countries,
      fee,
      privacy,
      changed,
      saved,
      warningCleared,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!warningCleared) {
      console.error("[warn] 页面仍有「必填信息未填写」提示，请检查版本页缺失字段");
      process.exitCode = 1;
    }
  } catch (e) {
    try {
      const f = await getFrame(page);
      if (f) console.error("[state]", clean(await f.evaluate(() => document.body?.innerText || "")).slice(0, 600));
    } catch {}
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
  });
