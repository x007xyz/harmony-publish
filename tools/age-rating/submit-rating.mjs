#!/usr/bin/env node
/**
 * submit-rating.mjs — 一次性完整执行：完成 AGC 年龄分级问卷并提交（全部 UI 路径）
 *
 * 通过 Playwriter 连接用户**正在运行的 Chrome**（保留 developer.huawei.com 登录态）。
 * 问卷作答必须在 AGC 网页完成（华为无问卷 API），但人工环节可完全去掉：
 * AI 基于应用真实功能预生成答案 → 脚本自动作答/验证/提交。
 *
 * 用法:
 *   node submit-rating.mjs --project <key> --stage questions
 *        # 打开问卷并输出全部题目(id+文本+选项),供 AI 生成答案 JSON
 *   node submit-rating.mjs --project <key> --stage answers  --answers <answers.json>
 *        # 仅作答(不验证不提交),用于检查
 *   node submit-rating.mjs --project <key> --stage submit   --answers <answers.json>
 *        # 一次性完整:作答 → 验证 → 选择预期分级 → 提交 → 处理儿童弹窗
 *
 * answers JSON 结构(由 AI 基于应用真实功能生成,不得伪造):
 *   {
 *     "yesIds": ["question-id-1", ...],   // 需答「是」的题目 id;无敏感内容则为 []
 *     "expectedAge": "年满 3 周岁",        // 预期分级选项文本(验证页 radio)
 *     "childFlag": 0                       // 1=仅面向儿童(会要求分类到「儿童」)
 *   }
 *
 * 前置条件: Chrome 已装 Playwriter 扩展并连接、已登录 developer.huawei.com。
 */
import { chromium } from "playwright-core";
import { startPlayWriterCDPRelayServer, getCdpUrl } from "playwriter";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "../..");
const PROJECTS = join(SKILL_DIR, "projects.json");
const VERSION_HOME =
  "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html";
const VERSION_ROUTE = "172249065903274627";
const TIMEOUT = 60000;

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

const projectArg = arg("--project");
const stage = arg("--stage", "submit");
const answersArg = arg("--answers");
if (!projectArg || !["questions", "answers", "submit"].includes(stage)) {
  console.error(
    "usage: node submit-rating.mjs --project <key> --stage <questions|answers|submit> [--answers <answers.json>]"
  );
  process.exit(2);
}
if (stage !== "questions" && !answersArg) {
  console.error("--answers <answers.json> is required for stages answers/submit");
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

const answers = stage === "questions" ? null : JSON.parse(readFileSync(resolve(answersArg), "utf8"));

async function getFrame(page) {
  await page
    .frameLocator("#mainIframeView")
    .locator("body")
    .waitFor({ timeout: TIMEOUT })
    .catch(() => {});
  return page.frames().find((f) => f.url().includes("distribute")) || null;
}

async function dumpState(page, label) {
  try {
    const frame = await getFrame(page);
    const text = frame
      ? clean(await frame.evaluate(() => document.body?.innerText || ""))
      : "(frame unavailable)";
    console.error(`[${label}]`, text.slice(0, 1000));
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

async function openQuestionnaire(page) {
  const fl = page.frameLocator("#mainIframeView");
  const frame = await getFrame(page);
  if (!frame) throw new Error("AGC iframe 未加载");
  const alreadyOpen = await fl.locator(".age-rating-questionnaire").count().catch(() => 0);
  if (alreadyOpen > 0) return;
  // 用 evaluate 点击,避免 iframe 重载导致的 frame detached 挂起
  const settingClicked = await frame.evaluate(() => {
    const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const btn = Array.from(document.querySelectorAll("button"))
      .find((n) => cleanV(n.innerText || n.textContent) === "设置" && n.offsetWidth > 0);
    btn?.click();
    return Boolean(btn);
  }).catch(() => false);
  if (!settingClicked) {
    await dumpState(page, "open-setting");
    throw new Error("内容分级「设置」按钮不可用");
  }
  await sleep(3000);
  const qOpen = await fl.locator(".age-rating-questionnaire").count().catch(() => 0);
  if (qOpen === 0) {
    const fillClicked = await frame.evaluate(() => {
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      const btn = Array.from(document.querySelectorAll("button"))
        .find((n) => /^(填写问卷|继续填写问卷)$/.test(cleanV(n.innerText || n.textContent)) && n.offsetWidth > 0);
      btn?.click();
      return Boolean(btn);
    }).catch(() => false);
    if (!fillClicked) {
      await dumpState(page, "open-questionnaire");
      throw new Error("「填写问卷」按钮不可用");
    }
  }
  await sleep(4000);
}

async function collectQuestions(frame) {
  return frame.evaluate(() => {
    const doc = document;
    const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
    return Array.from(doc.querySelectorAll(".question-wrap") || [])
      .map((node) => ({
        id: node.id || "",
        text: cleanV(node.innerText).slice(0, 1600),
        visible: doc.defaultView.getComputedStyle(node).display !== "none",
        options: Array.from(node.querySelectorAll('input[type="radio"],input[type="checkbox"]'))
          .map((input) => ({
            type: input.type,
            value: input.value,
            checked: input.checked,
            label: cleanV(input.closest("label,li,div")?.innerText).slice(0, 500),
          }))
          .filter((o) => o.label),
      }))
      .filter((q) => q.visible && (q.text || q.options.length));
  });
}

async function clickRadioByLabel(fl, rootLocator, labelText) {
  return rootLocator.evaluate((root, wanted) => {
    const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const doc = root.ownerDocument;
    const scope = root === doc.documentElement || root.matches(".question-wrap, [role=dialog], .el-dialog")
      ? root
      : doc.documentElement;
    const input = Array.from(scope.querySelectorAll('input[type="radio"]'))
      .find((node) => cleanV(node.closest("label,li,div")?.innerText) === wanted);
    if (!input || input.checked) return false;
    (input.closest("label") || input.closest(".el-radio") || input).click();
    return true;
  }, labelText);
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
  // 接管原生 JS 对话框,避免 Playwright 自动处理时的竞态错误
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  try {
    await page.goto(`${VERSION_HOME}#/myApp/${appId}/${VERSION_ROUTE}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await sleep(5000);
    // 关键:必须点击主文档菜单「版本信息 > 准备提交」,让 AGC 正确加载版本上下文。
    // 手动改 iframe src 会导致年龄分级验证接口 srvSerialNo 为空而失败。
    let menuClicked = false;
    for (let i = 0; i < 6; i++) {
      menuClicked = await page.evaluate(() => {
        const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const item = Array.from(document.querySelectorAll("li.el-menu-item.base-menu-item__third"))
          .find((n) => cleanV(n.innerText || n.textContent).includes("准备提交"));
        if (!item) return false;
        item.click();
        return true;
      }).catch(() => false);
      if (menuClicked) break;
      await sleep(3000);
    }
    if (!menuClicked) throw new Error("主菜单「版本信息 > 准备提交」不可用（请确认已进入应用版本页）");
    await sleep(7000);
    const fl = page.frameLocator("#mainIframeView");
    const frame = await getFrame(page);
    if (!frame) throw new Error("AGC 版本页 iframe 未加载（登录态可能失效）");

    await openQuestionnaire(page);

    if (stage === "questions") {
      const questions = await collectQuestions(frame);
      // 抓取到的题目保存到本地 release/age-rating-questions.json,
      // AI 据此 + 应用真实功能生成 answers(下次直接 --stage submit --answers,无需重抓)
      const releaseDir = join(cfg.projectRoot, "release");
      if (!existsSync(releaseDir)) mkdirSync(releaseDir, { recursive: true });
      const outPath = join(releaseDir, "age-rating-questions.json");
      writeFileSync(outPath, JSON.stringify({ project: projectArg, fetchedAt: new Date().toISOString(), count: questions.length, questions }, null, 2));
      console.log(JSON.stringify({ ok: true, stage: "questions", count: questions.length, savedTo: outPath, questions }, null, 1));
      return;
    }

    // 作答: yesIds 内的题目选「是」,其余选「否」(一次 evaluate 完成,已验证可靠)
    const yesIds = new Set(answers.yesIds || []);
    const questions = await collectQuestions(frame);
    if (questions.length === 0) throw new Error("问卷未加载出题目");
    const answered = await frame.evaluate((wantedIdsArr) => {
      const wantedIds = new Set(wantedIdsArr);
      const cleanV = (v) => String(v || "").replace(/\s+/g, " ").trim();
      let count = 0;
      for (const q of Array.from(document.querySelectorAll(".question-wrap"))) {
        if (document.defaultView.getComputedStyle(q).display === "none") continue;
        const shouldYes = wantedIds.has(q.id);
        const wanted = shouldYes ? "是" : "否";
        const input = Array.from(q.querySelectorAll("input[type=radio]"))
          .find((n) => cleanV(n.closest("label,li,div")?.innerText) === wanted);
        if (!input || input.checked) continue;
        (input.closest("label") || input.closest(".el-radio") || input).click();
        count++;
      }
      return count;
    }, Array.from(yesIds));
    await sleep(2500);

    if (stage === "submit") {
      const verifyBtn = fl.locator("[role=dialog], .age-rating-questionnaire", { hasText: "验证问题" })
        .getByRole("button", { name: "验证", exact: true }).first();
      if (await verifyBtn.count() > 0) {
        await verifyBtn.click({ timeout: 15000 }).catch(() => {});
        await sleep(5000);
      }

      const expectedAge = String(answers.expectedAge || "年满 3 周岁");
      const submitDialog = fl.locator("[role=dialog], .el-dialog", { hasText: "根据问卷" }).first();
      if (await submitDialog.count() === 0) {
        await dumpState(page, "submit-dialog");
        throw new Error("预期分级验证对话框未出现");
      }
      await clickRadioByLabel(fl, submitDialog, expectedAge);
      await sleep(800);
      const submitBtn = submitDialog.getByRole("button", { name: "提交", exact: true }).first();
      await submitBtn.click({ timeout: 15000 }).catch(() => {
        throw new Error("「提交」按钮不可用");
      });
      await sleep(4000);

      if (Number(answers.childFlag || 0) === 0) {
        const childrenDialog = fl.locator(".el-message-box, [role=dialog]", { hasText: "是否仅面向儿童" }).first();
        if (await childrenDialog.count() > 0) {
          await clickRadioByLabel(fl, childrenDialog, "否");
          await sleep(800);
          await childrenDialog.getByRole("button", { name: "确认", exact: true }).first().click();
          await sleep(2000);
        }
      }

      const successDialog = fl.locator(".el-message-box, [role=dialog]", { hasText: /成功|提交完成/ }).first();
      if (await successDialog.count() > 0) {
        await successDialog
          .getByRole("button", { name: /^(确认|确定|知道了)$/ })
          .first()
          .click()
          .catch(() => {});
        await sleep(1500);
      }

      // 点击版本页顶部「保存」持久化年龄分级结果
      const saveBtn = fl.locator("button", { hasText: "保存", exact: true }).first();
      if (await saveBtn.count() > 0) {
        const saveDisabled = await saveBtn.isDisabled().catch(() => true);
        if (!saveDisabled) {
          await saveBtn.click();
          await sleep(3000);
          const savedDialog = fl.locator(".el-message-box, [role=dialog]", { hasText: /保存成功/ }).first();
          if (await savedDialog.count() > 0) {
            await savedDialog.getByRole("button", { name: /^(确认|确定|知道了)$/ }).first().click().catch(() => {});
            await sleep(1500);
          }
        }
      }
    }

    const finalQuestions = await collectQuestions(frame);
    const bodyText = await frame.evaluate(() =>
      String(document.body?.innerText || "").replace(/\s+/g, " ").trim()
    );
    const result = {
      ok: true,
      project: projectArg,
      stage,
      answered,
      expectedAge: stage === "submit" ? answers.expectedAge : undefined,
      questions: finalQuestions,
      pageState: bodyText.includes("内容分级")
        ? bodyText.slice(0, 1500)
        : "(content rating section not found)",
    };
    console.log(JSON.stringify(result, null, 1));
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
