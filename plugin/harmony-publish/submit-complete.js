import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, bool, clickByText, frameClick, AGC_HOME, APP_INFO_ROUTE, projectConfig, resolveAppId } from "./shared.js";


cli({
  site: SITE,
  name: "submit-complete-ui",
  description: "UI fallback for final submission when the official Publishing API is unavailable",
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
    { name: "confirm-submit", type: "boolean", default: false, help: "Must be true to submit the release for review" },
  ],
  columns: ["status", "detail", "body", "dialogs"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const APP_INFO_URL = `${AGC_HOME}#/myApp/${await resolveAppId(page, cfg)}/${APP_INFO_ROUTE}`;
    if (!bool(args["confirm-submit"], false)) {
      throw new ArgumentError("Final submission is disabled; pass --confirm-submit true");
    }
    await page.goto(APP_INFO_URL, { waitUntil: "load", settleMs: 4000 });
    await page.wait({ time: 7 });
    const advanced = await frameClick(page, (doc) => {
      const submitVersion = doc?.querySelector("#goToVersionInfoLink");
      const next = doc?.querySelector("#NextStepButton");
      const target = submitVersion && !submitVersion.hasAttribute("disabled") ? submitVersion : next;
      if (!target || target.hasAttribute("disabled")) return null;
      return target;
    });
    if (!advanced) throw new CommandExecutionError("Application-info Submit version action is unavailable");
    await page.wait({ time: 2 });
    const nextConfirmed = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const iframeDoc = document.querySelector("#mainIframeView")?.contentDocument;
      if (clean(iframeDoc?.body?.innerText).includes("提交审核")) return true;
      const docs = [iframeDoc, document].filter(Boolean);
      return Boolean(docs.flatMap((doc) =>
        Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box')))
        .find((node) => clean(node.innerText).includes("请确认是否继续跳转到版本信息页面")));
    });
    if (nextConfirmed) {
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const docs = [doc, document].filter(Boolean);
        const dialog = docs.flatMap((d) =>
          Array.from(d.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box')))
          .find((node) => clean(node.innerText).includes("请确认是否继续跳转到版本信息页面"));
        const confirm = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => clean(node.innerText || node.textContent) === "确认"
            && !node.hasAttribute("disabled"));
        return confirm || null;
      });
    }
    await page.wait({ time: 8 });
    const versionState = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const body = clean(doc?.body?.innerText);
      const save = Array.from(doc?.querySelectorAll("button") || [])
        .find((node) => clean(node.innerText || node.textContent) === "保存");
      return {
        body: body.slice(0, 5000),
        hasSubmit: body.includes("提交审核"),
        saveEnabled: Boolean(save && !save.hasAttribute("disabled")),
      };
    });
    if (!versionState.hasSubmit) {
      throw new CommandExecutionError(`Version form did not open after Next: ${versionState.body}`);
    }
    if (versionState.saveEnabled) {
      await clickByText(page, "保存");
      await page.wait({ time: 5 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const device = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box'))
          .find((node) => clean(node.innerText).includes("软件包可支持分发的设备范围"));
        const ignore = Array.from(device?.querySelectorAll("button") || [])
          .find((node) => clean(node.innerText || node.textContent) === "忽略"
            && !node.hasAttribute("disabled"));
        return ignore || null;
      });
      await page.wait({ time: 10 });
    }
    const hasSaveSuccess = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      return Array.from(doc?.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box') || [])
        .some((node) => /保存成功/.test(clean(node.innerText)));
    });
    if (hasSaveSuccess) {
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box'))
          .find((node) => /保存成功/.test(clean(node.innerText)));
        const confirm = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => /^(确认|确定)$/.test(clean(node.innerText || node.textContent))
            && !node.hasAttribute("disabled"));
        return confirm || null;
      });
    }
    const clicked = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const matches = Array.from(doc?.querySelectorAll("button,[role=button]") || [])
        .filter((node) => clean(node.innerText || node.textContent) === "提交审核"
          && !node.hasAttribute("disabled"));
      if (matches.length !== 1) return { ok: false, count: matches.length };
      return {
        ok: true,
        count: 1,
        text: clean(matches[0].innerText || matches[0].textContent),
      };
    });
    if (clicked.ok) {
      const clickedSubmit = await clickByText(page, clicked.text);
      if (!clickedSubmit) clicked.ok = false;
    }
    if (!clicked.ok) throw new CommandExecutionError(`Expected one Submit review button; found ${clicked.count}`);
    await page.wait({ time: 5 });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await page.evaluate(() => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (node) => {
          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const iframeDoc = document.querySelector("#mainIframeView")?.contentDocument;
        const docs = [iframeDoc, document].filter(Boolean);
        const dialog = docs.flatMap((doc) =>
          Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box')))
          .filter(visible)
          .find((node) => !/保存成功/.test(clean(node.innerText)));
        if (!dialog) {
          const body = clean(iframeDoc?.body?.innerText);
          if (/预审中|正在预审|审核中|已提交|提交成功|待审核|审核状态/i.test(body)) {
            return { state: "done", body: body.slice(0, 8000) };
          }
          const submit = Array.from(iframeDoc?.querySelectorAll("button,[role=button]") || [])
            .filter((node) => visible(node) && !node.hasAttribute("disabled"))
            .find((node) => clean(node.innerText || node.textContent) === "提交审核");
          if (body.includes("准备提交") && submit) {
            return { state: "resubmit", body: body.slice(0, 8000) };
          }
          return { state: "none", body: body.slice(0, 8000) };
        }
        const body = clean(dialog.innerText).slice(0, 8000);
        if (body.includes("软件包可支持分发的设备范围大于AGC")
          || body.includes("软件包可支持分发的设备范围")) {
          const ignore = Array.from(dialog.querySelectorAll("button"))
            .filter((node) => !node.hasAttribute("disabled"))
            .find((node) => clean(node.innerText || node.textContent) === "忽略");
          if (!ignore) return { state: "dialog", body };
          return { state: "device-ignore", body };
        }
        if (/请填写|不能为空|不符合|错误|失败|修改重试|校验/.test(body)) {
          return { state: "validation", body };
        }
        const checkboxCount = Array.from(dialog.querySelectorAll('input[type="checkbox"]'))
          .filter((node) => !node.checked && !node.disabled).length;
        const button = Array.from(dialog.querySelectorAll("button"))
          .filter((node) => !node.hasAttribute("disabled"))
          .find((node) => /^(确认提交|提交|确认|确定|同意)$/.test(clean(node.innerText || node.textContent)));
        if (!button) return { state: "dialog", body };
        return { state: "ready", body, checkboxCount };
      });
      if (result.state === "validation") {
        throw new CommandExecutionError(`AGC validation blocked submission: ${result.body}`);
      }
      if (result.state === "dialog") {
        throw new CommandExecutionError(`AGC confirmation could not be completed: ${result.body}`);
      }
      if (result.state === "none" || result.state === "done") break;
      if (result.state === "resubmit") {
        const resubmitted = await clickByText(page, "提交审核");
        if (!resubmitted) {
          throw new CommandExecutionError(`AGC confirmation could not be completed: ${result.body}`);
        }
        result.state = "resubmitted";
      }
      if (result.state === "device-ignore") {
        const ignored = await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const docs = [doc, document].filter(Boolean);
          const dialog = docs.flatMap((d) =>
            Array.from(d.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box')))
            .find((node) => clean(node.innerText).includes("软件包可支持分发的设备范围"));
          const ignore = Array.from(dialog?.querySelectorAll("button") || [])
            .filter((node) => !node.hasAttribute("disabled"))
            .find((node) => clean(node.innerText || node.textContent) === "忽略");
          return ignore || null;
        });
        if (!ignored) {
          throw new CommandExecutionError(`AGC confirmation could not be completed: ${result.body}`);
        }
        result.state = "ignored-device-range";
      }
      if (result.state === "ready") {
        for (let index = 0; index < result.checkboxCount; index += 1) {
          const picked = await frameClick(page, (doc) => {
            const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
            const visible = (node) => {
              const style = node.ownerDocument.defaultView.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            };
            const docs = [doc, document].filter(Boolean);
            const dialog = docs.flatMap((d) =>
              Array.from(d.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box')))
              .filter(visible)
              .find((node) => !/保存成功/.test(clean(node.innerText)));
            const checkbox = Array.from(dialog?.querySelectorAll('input[type="checkbox"]') || [])
              .find((node) => !node.checked && !node.disabled);
            if (!checkbox) return null;
            return checkbox.closest("label") || checkbox.closest(".el-checkbox") || checkbox;
          });
          if (!picked) break;
          await page.wait({ time: 1 });
        }
        const clicked = await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const visible = (node) => {
            const style = node.ownerDocument.defaultView.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const docs = [doc, document].filter(Boolean);
          const dialog = docs.flatMap((d) =>
            Array.from(d.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box')))
            .filter(visible)
            .find((node) => !/保存成功/.test(clean(node.innerText)));
          const button = Array.from(dialog?.querySelectorAll("button") || [])
            .filter((node) => !node.hasAttribute("disabled"))
            .find((node) => /^(确认提交|提交|确认|确定|同意)$/.test(clean(node.innerText || node.textContent)));
          return button || null;
        });
        if (!clicked) {
          throw new CommandExecutionError(`AGC confirmation could not be completed: ${result.body}`);
        }
        result.state = "clicked";
      }
      await page.wait({ time: result.state === "ignored-device-range" ? 10 : 5 });
    }
    await page.wait({ time: 15 });
    const after = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const iframeDoc = document.querySelector("#mainIframeView")?.contentDocument;
      const dialogs = [iframeDoc, document].filter(Boolean).flatMap((doc) =>
        Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box'))
          .map((node) => clean(node.innerText))
          .filter(Boolean));
      return {
        body: clean(iframeDoc?.body?.innerText).slice(0, 16000),
        outerBody: clean(document.body?.innerText).slice(0, 8000),
        dialogs,
      };
    });
    const text = [after.body, after.outerBody, ...after.dialogs].join(" ");
    if (!/预审中|正在预审|审核中|已提交|提交成功|submitted|under review|待审核|审核状态/i.test(text)) {
      throw new CommandExecutionError(`Submission status not verified: ${text.slice(0, 4000)}`);
    }
    return [{
      status: "submitted",
      detail: "Application information and release version were submitted in one page lease",
      body: after.body.slice(0, 5000),
      dialogs: after.dialogs,
    }];
  },
});
