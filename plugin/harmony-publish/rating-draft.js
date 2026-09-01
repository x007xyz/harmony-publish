import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, clickByText, frameClick, navigateVersionPage, projectConfig } from "./shared.js";

// Live Photo is a local-only utility: it has no account, personal-data collection,
// location service, payments, social features, or unrestricted web access.
const YES_IDS = new Set();

cli({
  site: SITE,
  name: "rating-draft-ui",
  description: "UI questionnaire fallback for producing or submitting age-rating feedback",
  access: "write",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "stage", default: "answers", choices: ["answers", "verify", "submit"], help: "Stop after answers, continue to verification, or submit the truthful 3+ result" },
  ],
  columns: ["status", "answered", "dialogText", "questions"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    await navigateVersionPage(page, cfg);
    await page.wait({ time: 6 });
    await openQuestionnaire(page);
    const childrenFinalized = String(args.stage) === "submit" && await (async () => {
      const dialogFound = await page.evaluate(() => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        return Boolean(Array.from(doc?.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog') || [])
          .find((node) => clean(node.innerText).includes("是否仅面向儿童")));
      });
      if (!dialogFound) return false;
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
          .find((node) => clean(node.innerText).includes("是否仅面向儿童"));
        const noInput = Array.from(dialog?.querySelectorAll('input[type="radio"]') || [])
          .find((input) => clean(input.closest("label,li,div")?.innerText) === "否");
        if (!noInput || noInput.checked) return null;
        return noInput.closest("label") || noInput.closest(".el-radio") || noInput;
      });
      const confirmed = await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
          .find((node) => clean(node.innerText).includes("是否仅面向儿童"));
        const confirm = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => clean(node.innerText || node.textContent) === "确认"
            && !node.hasAttribute("disabled"));
        return confirm || null;
      });
      return Boolean(confirmed);
    })();
    if (childrenFinalized) await page.wait({ time: 6 });
    const warningOpen = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      return Boolean(Array.from(doc?.querySelectorAll('[role="dialog"],.el-message-box') || [])
        .find((node) => String(node.innerText || "").includes("处理请求时发生未知错误")));
    });
    if (warningOpen) {
      await frameClick(page, (doc) => {
        const warning = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box'))
          .find((node) => String(node.innerText || "").includes("处理请求时发生未知错误"));
        const confirm = Array.from(warning?.querySelectorAll("button") || [])
          .find((node) => String(node.innerText || node.textContent).replace(/\s+/g, " ").trim() === "确认"
            && !node.hasAttribute("disabled"));
        return confirm || null;
      });
    }
    const answerPlan = await page.evaluate((yesIds) => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const toggles = [];
      for (const question of Array.from(doc?.querySelectorAll(".question-wrap") || [])) {
        const wanted = yesIds.includes(question.id) ? "是" : "否";
        const input = Array.from(question.querySelectorAll('input[type="radio"]'))
          .find((node) => String(node.closest("label,li,div")?.innerText || "").replace(/\s+/g, " ").trim() === wanted);
        if (input && !input.checked) toggles.push({ id: question.id, wanted });
      }
      return toggles;
    }, Array.from(YES_IDS));
    let answered = 0;
    for (const item of answerPlan) {
      const picked = await frameClick(page, (doc, win, vals) => {
        const question = Array.from(doc.querySelectorAll(".question-wrap"))
          .find((node) => node.id === vals.id);
        const input = Array.from(question?.querySelectorAll('input[type="radio"]') || [])
          .find((node) => String(node.closest("label,li,div")?.innerText || "").replace(/\s+/g, " ").trim() === vals.wanted);
        if (!input || input.checked) return null;
        return input.closest("label") || input.closest(".el-radio") || input;
      }, { id: item.id, wanted: item.wanted });
      if (picked) answered += 1;
    }
    await page.wait({ time: 3 });
    if (!childrenFinalized && ["verify", "submit"].includes(String(args.stage))) {
      const alreadyVerified = await page.evaluate(() => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const dialog = Array.from(doc?.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog') || [])
          .find((node) => String(node.innerText || "").includes("填写问卷")
            && String(node.innerText || "").includes("验证问题"));
        return String(dialog?.innerText || "").includes("根据问卷")
          && String(dialog?.innerText || "").includes("提交");
      });
      const verified = alreadyVerified || await frameClick(page, (doc) => {
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog'))
          .find((node) => String(node.innerText || "").includes("填写问卷")
            && String(node.innerText || "").includes("验证问题"));
        const button = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => String(node.innerText || node.textContent).replace(/\s+/g, " ").trim() === "验证"
            && !node.hasAttribute("disabled"));
        return button || null;
      });
      if (!verified) throw new CommandExecutionError("Rating questionnaire Verify button is unavailable");
      await page.wait({ time: 3 });
    }
    if (!childrenFinalized && String(args.stage) === "submit") {
      const submitted = await (async () => {
        const dialogFound = await page.evaluate(() => {
          const doc = document.querySelector("#mainIframeView")?.contentDocument;
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          return Boolean(Array.from(doc?.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog') || [])
            .find((node) => clean(node.innerText).includes("根据问卷")
              && clean(node.innerText).includes("年满 3 周岁")));
        });
        if (!dialogFound) return { ok: false, reason: "verification_dialog_not_found" };
        await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog'))
            .find((node) => clean(node.innerText).includes("根据问卷")
              && clean(node.innerText).includes("年满 3 周岁"));
          const threeText = Array.from(dialog?.querySelectorAll("label,li,div,span") || [])
            .find((node) => clean(node.innerText || node.textContent) === "年满 3 周岁");
          const optionRoot = threeText?.closest("label,li,.el-radio,.rating-item,div");
          const radio = optionRoot?.querySelector('input[type="radio"]')
            || Array.from(dialog?.querySelectorAll('input[type="radio"]') || [])
              .find((input) => clean(input.closest("label,li,div")?.innerText).includes("年满 3 周岁"));
          if (radio) {
            if (radio.checked) return null;
            return radio.closest("label") || radio.closest(".el-radio") || radio;
          }
          return threeText || null;
        });
        const submitClicked = await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog'))
            .find((node) => clean(node.innerText).includes("根据问卷")
              && clean(node.innerText).includes("年满 3 周岁"));
          const button = Array.from(dialog?.querySelectorAll("button") || [])
            .find((node) => clean(node.innerText || node.textContent) === "提交"
              && !node.hasAttribute("disabled"));
          return button || null;
        });
        if (!submitClicked) return { ok: false, reason: "submit_unavailable" };
        const selected = await page.evaluate(() => {
          const doc = document.querySelector("#mainIframeView")?.contentDocument;
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const dialog = Array.from(doc?.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog') || [])
            .find((node) => clean(node.innerText).includes("根据问卷")
              && clean(node.innerText).includes("年满 3 周岁"));
          const threeText = Array.from(dialog?.querySelectorAll("label,li,div,span") || [])
            .find((node) => clean(node.innerText || node.textContent) === "年满 3 周岁");
          const optionRoot = threeText?.closest("label,li,.el-radio,.rating-item,div");
          const radio = optionRoot?.querySelector('input[type="radio"]')
            || Array.from(dialog?.querySelectorAll('input[type="radio"]') || [])
              .find((input) => clean(input.closest("label,li,div")?.innerText).includes("年满 3 周岁"));
          return Boolean(radio?.checked);
        });
        return { ok: true, selected };
      })();
      if (!submitted.ok) throw new CommandExecutionError(`Rating questionnaire submit failed: ${submitted.reason}`);
      await page.wait({ time: 6 });
      const childrenDialogOpen = await page.evaluate(() => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        return Boolean(Array.from(doc?.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog') || [])
          .find((node) => clean(node.innerText).includes("是否仅面向儿童")));
      });
      if (childrenDialogOpen) {
        await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const children = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
            .find((node) => clean(node.innerText).includes("是否仅面向儿童"));
          const noInput = Array.from(children?.querySelectorAll('input[type="radio"]') || [])
            .find((input) => clean(input.closest("label,li,div")?.innerText) === "否");
          if (!noInput || noInput.checked) return null;
          return noInput.closest("label") || noInput.closest(".el-radio") || noInput;
        });
        await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const children = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
            .find((node) => clean(node.innerText).includes("是否仅面向儿童"));
          const confirm = Array.from(children?.querySelectorAll("button") || [])
            .find((node) => clean(node.innerText || node.textContent) === "确认"
              && !node.hasAttribute("disabled"));
          return confirm || null;
        });
      }
      await page.wait({ time: 5 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const success = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box'))
          .find((node) => /成功|提交完成/.test(clean(node.innerText)));
        const confirm = Array.from(success?.querySelectorAll("button") || [])
          .find((node) => /^(确认|确定|知道了)$/.test(clean(node.innerText || node.textContent))
            && !node.hasAttribute("disabled"));
        return confirm || null;
      });
      await page.wait({ time: 2 });
    }
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const dialog = Array.from(doc?.querySelectorAll('[role="dialog"],.age-rating-questionnaire,.el-dialog') || [])
        .find((node) => String(node.innerText || "").includes("内容分级"));
      return {
        dialogText: clean(dialog?.innerText).slice(0, 6000),
        questions: Array.from(doc?.querySelectorAll(".question-wrap") || []).map((node) => ({
          id: node.id || "",
          text: clean(node.innerText).slice(0, 1600),
          visible: doc.defaultView.getComputedStyle(node).display !== "none",
          options: Array.from(node.querySelectorAll('input[type="radio"],input[type="checkbox"]')).map((input) => ({
            type: input.type,
            value: input.value,
            checked: input.checked,
            label: clean(input.closest("label,li,div")?.innerText).slice(0, 500),
          })),
        })),
      };
    });
    return [{
      status: String(args.stage) === "submit"
        ? "rating_submitted"
        : String(args.stage) === "verify" ? "verification_step_ready" : "base_answers_ready",
      answered,
      dialogText: state.dialogText,
      questions: state.questions,
    }];
  },
});

async function openQuestionnaire(page) {
  const alreadyOpen = await page.evaluate(() => {
    const doc = document.querySelector("#mainIframeView")?.contentDocument;
    return Boolean(doc?.querySelector(".age-rating-questionnaire"));
  });
  if (alreadyOpen) return;
  const opened = await clickByText(page, "设置");
  if (!opened) throw new CommandExecutionError("Could not open the rating manager");
  await page.wait({ time: 2 });
  const questionnaireOpen = await page.evaluate(() => {
    const doc = document.querySelector("#mainIframeView")?.contentDocument;
    return Boolean(doc?.querySelector(".age-rating-questionnaire"));
  });
  const questionnaire = questionnaireOpen || await frameClick(page, (doc) => {
    const button = Array.from(doc?.querySelectorAll("button") || [])
      .find((node) => /^(填写问卷|继续填写问卷)$/.test(
        String(node.innerText || node.textContent).replace(/\s+/g, " ").trim(),
      ));
    return button || null;
  });
  if (!questionnaire) throw new CommandExecutionError("Could not open the rating questionnaire");
  await page.wait({ time: 3 });
}
