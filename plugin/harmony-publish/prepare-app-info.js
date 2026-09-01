import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, AGC_HOME, APP_INFO_ROUTE, clickByText, frameClick, projectConfig, projectPath, readAppInfo, resolveAppId } from "./shared.js";


cli({
  site: SITE,
  name: "prepare-app-info-ui",
  description: "UI fallback for application information when the official Publishing API is unavailable",
  access: "write",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "icon", default: "", help: "1024px PNG icon; defaults to AppScope/resources/base/media/app_icon.png" },
  ],
  columns: ["status", "category", "tag", "icon", "detail"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const project = projectPath(args.project);
    const appInfoUrl = `${AGC_HOME}#/myApp/${cfg.appId}/${APP_INFO_ROUTE}`;
    const icon = resolve(String(args.icon || "").trim() || resolve(project, "AppScope/resources/base/media/app_icon.png"));
    if (!existsSync(icon)) throw new ArgumentError(`App icon not found: ${icon}`);
    const appName = readAppInfo(project).appName;

    const targetUrl = cfg.appId ? appInfoUrl : "";
    if (targetUrl) await page.goto(targetUrl, { waitUntil: "load", settleMs: 4000 });
    else {
      const appId = await resolveAppId(page, cfg);
      await page.goto(`${AGC_HOME}#/myApp/${appId}/${APP_INFO_ROUTE}`, { waitUntil: "load", settleMs: 4000 });
    }
    await page.wait({ time: 6 });
    const nameFilled = await page.evaluate((name) => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const items = Array.from(doc?.querySelectorAll(".el-form-item") || []);
      const item = items.find((it) => /应用名称/.test(it.innerText || ""));
      const input = item?.querySelector("input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, name);
      else input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, appName);
    if (!nameFilled) throw new CommandExecutionError("Application name input is unavailable");
    await page.wait({ time: 1 });
    const opened = await frameClick(page, (doc) => {
      const inputs = Array.from(doc.querySelectorAll('input[placeholder="请选择"]'));
      return inputs.at(-1) || null;
    });
    if (!opened) throw new CommandExecutionError("Application category picker is unavailable");
    await page.wait({ time: 1 });
    await clickMenuText(page, "应用");
    await page.wait({ time: 1 });
    await clickMenuText(page, cfg.category);
    await page.wait({ time: 1 });

    const tagDialog = await frameClick(page, (doc) => {
      const button = doc.querySelector("#AppInfoManageCategoryTagButton");
      if (!button || button.hasAttribute("disabled")) return null;
      return button;
    });
    if (!tagDialog) throw new CommandExecutionError(`Tag manager is unavailable after selecting ${cfg.category}`);
    await page.wait({ time: 2 });
    const tagSelected = await frameClick(page, (doc, win, vals) => {
      const rows = Array.from(doc.querySelectorAll("#AppInfoCategoryTable tbody tr"));
      const row = rows.find((item) => {
        const cells = item.querySelectorAll("td");
        return String(cells[1]?.innerText || "").trim() === vals.tag
          && String(cells[2]?.innerText || "").trim() === vals.category;
      });
      if (!row) return null;
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox || checkbox.checked) return null;
      return checkbox.closest("label") || checkbox.closest(".el-checkbox") || checkbox;
    }, { tag: cfg.tag, category: cfg.category });
    if (!tagSelected) throw new CommandExecutionError(`Could not select the ${cfg.tag} tag`);
    await page.wait({ time: 1 });
    const tagConfirmed = await frameClick(page, (doc) => {
      const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
        .find((node) => String(node.innerText || "").includes("管理标签"));
      const confirm = Array.from(dialog?.querySelectorAll("button") || [])
        .find((node) => String(node.innerText || node.textContent).replace(/\s+/g, " ").trim() === "确认" && !node.hasAttribute("disabled"));
      return confirm || null;
    });
    if (!tagConfirmed) throw new CommandExecutionError(`Could not confirm the ${cfg.tag} tag`);
    await page.wait({ time: 2 });

    const iconInputReady = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const target = doc?.querySelector('input[type="file"][accept*=".png"]');
      if (!target) return false;
      window.__opencliAgcIconTarget = target;
      window.__opencliAgcIconParent = target.parentNode;
      window.__opencliAgcIconNext = target.nextSibling;
      target.id = "opencli-agc-icon-target";
      document.body.appendChild(target);
      return true;
    });
    if (!iconInputReady) throw new CommandExecutionError("App icon file input is unavailable");
    const upload = await page.uploadFiles("#opencli-agc-icon-target", [icon]);
    if (!upload?.uploaded || upload.files !== 1) throw new CommandExecutionError("OpenCLI did not select one app icon");
    const transferred = await page.evaluate(() => {
      const frame = document.querySelector("#mainIframeView");
      const target = document.querySelector("#opencli-agc-icon-target");
      const parent = window.__opencliAgcIconParent;
      const next = window.__opencliAgcIconNext;
      // The native file-input bridge dispatches change. Vue may therefore
      // consume the file and replace the input before this follow-up runs.
      if (!target) return true;
      if (!parent) return false;
      if (next?.parentNode === parent) parent.insertBefore(target, next);
      else parent.appendChild(target);
      if (target.files?.length) {
        const EventCtor = frame.contentWindow.Event;
        target.dispatchEvent(new EventCtor("input", { bubbles: true }));
        target.dispatchEvent(new EventCtor("change", { bubbles: true }));
      }
      return true;
    });
    if (!transferred) throw new CommandExecutionError("Could not transfer the icon into the AGC iframe");
    await page.wait({ time: 3 });

    const iconConfirmed = await frameClick(page, (doc) => {
      const dialogs = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'));
      const iconDialog = dialogs.find((node) => /裁剪|展示效果|图标/.test(String(node.innerText || "")));
      const confirm = Array.from(iconDialog?.querySelectorAll("button") || [])
        .find((node) => /^(确定|确认)$/.test(String(node.innerText || node.textContent).replace(/\s+/g, " ").trim()) && !node.hasAttribute("disabled"));
      return confirm || null;
    });
    if (!iconConfirmed) throw new CommandExecutionError("Icon crop confirmation is unavailable");
    await page.wait({ time: 3 });

    const saved = await frameClick(page, (doc) => {
      const save = doc?.querySelector("#SaveButton");
      if (!save || save.hasAttribute("disabled")) return null;
      return save;
    });
    if (!saved) throw new CommandExecutionError("Save is unavailable; one or more app information fields may still be incomplete");
    await page.wait({ time: 5 });
    const result = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const text = String(doc?.body?.innerText || "").replace(/\s+/g, " ").trim();
      const category = Array.from(doc?.querySelectorAll("input") || [])
        .find((node) => String(node.value || "").includes("美食"))?.value || "";
      return {
        category,
        hasTag: text.includes("食谱"),
        errors: Array.from(doc?.querySelectorAll(".el-form-item__error,.error-message,[role=alert]") || [])
          .map((node) => String(node.innerText || node.textContent).trim())
          .filter(Boolean),
        text: text.slice(0, 5000),
      };
    });
    if (result.errors.length) throw new CommandExecutionError(`AGC rejected application information: ${result.errors.join("; ")}`);
    return [{
      status: "saved",
      category: result.category || "应用 / 美食",
      tag: result.hasTag ? "食谱" : "食谱（已提交）",
      icon,
      detail: "Application information saved",
    }];
  },
});

async function clickMenuText(page, text) {
  const clicked = await frameClick(page, (doc, win, vals) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(doc.querySelectorAll(".el-cascader-node,[role=menuitem],li"))
      .find((node) => normalize(node.innerText || node.textContent) === vals.text && node.offsetParent !== null)
      || null;
  }, { text });
  if (!clicked) throw new CommandExecutionError(`Could not choose category item: ${text}`);
}
