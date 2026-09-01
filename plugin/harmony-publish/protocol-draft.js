import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { readFileSync } from "node:fs";

import { SITE, AGC_HOME, PROTOCOL_ROUTE, projectConfig, resolveAppId, clickByTextWide, frameClick, frameClickWide, metadataPath, projectDir } from "./shared.js";
import { join } from "node:path";

function policyCopy(cfg, email) {
  let metadata = {};
  try {
    metadata = JSON.parse(readFileSync(metadataPath(cfg), "utf8"));
  } catch {
    // Fall back to projects.json fields when metadata is unavailable.
  }
  const appName = String(metadata.appName?.["zh-CN"] || cfg.appName || cfg.displayName || cfg.key).trim();
  const mainName = appName.split(/[：:]/)[0].trim() || appName;
  const short = String(metadata.shortDescription?.["zh-CN"] || "").trim() || `${mainName}：本地数据管理工具`;
  const description = String(metadata.description?.["zh-CN"] || "").trim();
  const functions = [];
  if (description) {
    const sentences = description.split(/[。；;]/).map((item) => item.trim()).filter(Boolean);
    for (const sentence of sentences.slice(0, 2)) {
      const cleaned = sentence.replace(/^你可以|^您可以|^应用会|^内置/, "").trim();
      if (cleaned.length >= 4 && cleaned.length <= 60) functions.push(cleaned);
    }
  }
  if (functions.length === 0) functions.push(short);
  functions.push("所有数据均在设备本地处理，不收集个人信息");
  const contact = `隐私问题请联系：${email}。本应用不注册账号、不上传数据、不收集个人信息。`;
  return {
    name: `${mainName}隐私政策`,
    intro: `${short}。所有数据均在设备本地处理，无需注册账号，不联网、不上传任何数据。`,
    path: "本应用不设置服务模式，所有数据均在设备本地处理",
    functions: functions.slice(0, 2),
    server: "用户设备本地（不上传至服务器）",
    contact,
  };
}

const NON_SENSITIVE = new Set(["ohos.permission.INTERNET"]);

function declaredPermissions(cfg) {
  const modulePath = join(projectDir(cfg), "entry", "src", "main", "module.json5");
  try {
    const text = readFileSync(modulePath, "utf8");
    return [...text.matchAll(/"name"\s*:\s*"((?:ohos\.permission\.)[A-Z_.0-9]+)"/g)]
      .map((match) => match[1])
      .filter((name) => !NON_SENSITIVE.has(name));
  } catch {
    return [];
  }
}

cli({
  site: SITE,
  name: "protocol-draft-ui",
  description: "Create and inspect a project Huawei-hosted privacy-policy draft",
  access: "write",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. recipe_master)" },
    { name: "stage", default: "editor", choices: ["editor", "validate", "select-options", "core-select", "permission-dialog", "contact-dialog", "contact-options", "complete-draft", "publish-no-data", "update-permissions", "publish", "save-current"], help: "Open, validate, or prepare the policy editor" },
    { name: "email", default: "", help: "Public privacy contact email" },
  ],
  columns: ["status", "body", "controls"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const copy = policyCopy(cfg, String(args.email || ""));
    const PROTOCOL_URL = `${AGC_HOME}#/myApp/${await resolveAppId(page, cfg)}/${PROTOCOL_ROUTE}`;
    await page.goto(PROTOCOL_URL, { waitUntil: "load", settleMs: 4000 });
    await page.wait({ time: 6 });
    const editorOpen = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      return Boolean(doc?.querySelector('input[placeholder="产品简介"]'));
    });
    if (!editorOpen) {
      const existingOpened = await frameClick(page, (doc, win, vals) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const row = Array.from(doc.querySelectorAll("tr"))
          .find((node) => clean(node.innerText).includes(vals.name));
        const edit = Array.from(row?.querySelectorAll("button,a,[role=button]") || [])
          .find((node) => clean(node.innerText || node.textContent) === "编辑");
        if (!edit || edit.hasAttribute("disabled")) return null;
        return edit;
      }, { name: copy.name });
      if (existingOpened) {
        await page.wait({ time: 2 });
        const advancedExisting = await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
            .find((node) => clean(node.innerText).includes("编辑协议"));
          const next = Array.from(dialog?.querySelectorAll("button") || [])
            .find((node) => clean(node.innerText || node.textContent) === "下一步"
              && !node.hasAttribute("disabled"));
          return next || null;
        });
        if (!advancedExisting) {
          throw new CommandExecutionError("Could not advance from the existing privacy-policy dialog");
        }
        await page.wait({ time: 6 });
      } else {
      const opened = await clickByTextWide(page, "新建协议");
      if (!opened) {
        const pageState = await page.evaluate(() => {
          const doc = document.querySelector("#mainIframeView")?.contentDocument;
          const win = doc?.defaultView;
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const visible = (node) => {
            const style = win.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          return {
            iframe: Boolean(doc),
            body: clean(doc?.body?.innerText).slice(0, 4000),
            buttons: Array.from(doc?.querySelectorAll("button,a,[role=button]") || [])
              .filter(visible)
              .map((node) => clean(node.innerText || node.textContent).slice(0, 80))
              .filter(Boolean)
              .slice(0, 40),
          };
        });
        throw new CommandExecutionError(`New protocol button is unavailable: ${JSON.stringify(pageState)}`);
      }
      await page.wait({ time: 2 });
      const filled = await page.evaluate((name) => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const dialog = Array.from(doc?.querySelectorAll('[role="dialog"],.el-dialog') || [])
        .find((node) => clean(node.innerText).includes("协议名称"));
      const input = Array.from(dialog?.querySelectorAll('input[type="text"]') || [])
        .find((node) => Number(node.maxLength) === 100);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      if (setter) setter.call(input, name);
      else input.value = name;
      input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
      input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      return true;
      }, copy.name);
      if (!filled) throw new CommandExecutionError("Could not fill the privacy-policy name");
      await page.wait({ time: 2 });
      const advanced = await frameClick(page, (doc) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
        .find((node) => clean(node.innerText).includes("协议名称"));
      const next = Array.from(dialog?.querySelectorAll("button") || [])
        .find((node) => clean(node.innerText || node.textContent) === "下一步"
          && !node.hasAttribute("disabled"));
      return next || null;
      });
      if (!advanced) throw new CommandExecutionError("Could not advance to the privacy-policy editor");
      await page.wait({ time: 5 });
      }
    }
    if (String(args.stage) === "publish-no-data") {
      if (!String(args.email || "").includes("@")) {
        throw new CommandExecutionError("A valid privacy contact email is required");
      }
      const filled = await page.evaluate((copy) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        const intro = doc?.querySelector('input[placeholder="产品简介"]');
        const path = Array.from(doc?.querySelectorAll(
          'input[placeholder="请输入应用内服务模式设置页面路径"]',
        ) || []).find((node) => !node.disabled);
        if (!intro || !path) return false;
        setValue(intro, copy.intro);
        setValue(path, copy.path);
        return true;
      }, copy);
      if (!filled) throw new CommandExecutionError("Could not fill the no-data policy introduction");
      await page.wait({ time: 2 });
      await frameClickWide(page, (doc) => {
        const inputs = Array.from(doc.querySelectorAll('input[role="combobox"]'))
          .filter((node) => !node.disabled);
        const input = inputs[1];
        return input?.closest(".el-select")?.querySelector(".el-select__wrapper") || null;
      });
      const selected = await frameClickWide(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const option = Array.from(doc.querySelectorAll("li,[role=option]"))
          .find((node) => clean(node.innerText || node.textContent) === "不收集个人信息");
        return option || null;
      });
      if (!selected) {
        const dropdownState = await page.evaluate(() => {
          const doc = document.querySelector("#mainIframeView")?.contentDocument;
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          return {
            selects: Array.from(doc?.querySelectorAll(".el-select") || [])
              .map((node) => ({ expanded: node.classList.contains("is-expanded") || Boolean(node.querySelector(".is-expanded")), text: clean(node.innerText).slice(0, 120) }))
              .slice(0, 8),
            allOptions: Array.from(doc?.querySelectorAll("li,[role=option],.el-select-dropdown__item") || [])
              .map((node) => clean(node.innerText || node.textContent).slice(0, 100))
              .filter(Boolean)
              .slice(0, 30),
            poppers: Array.from(doc?.querySelectorAll(".el-popper,.el-select-dropdown") || [])
              .map((node) => ({ hidden: node.offsetWidth === 0 && node.offsetHeight === 0, text: clean(node.innerText).slice(0, 300) }))
              .filter((item) => item.text)
              .slice(0, 6),
            labels: Array.from(doc?.querySelectorAll("label,.el-form-item__label") || [])
              .map((node) => clean(node.innerText).slice(0, 80))
              .filter(Boolean)
              .slice(0, 20),
          };
        });
        throw new CommandExecutionError(`No-personal-information option is unavailable: ${JSON.stringify(dropdownState)}`);
      }
      await page.wait({ time: 2 });
      const featuresFilled = await page.evaluate((copy) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        const features = Array.from(doc.querySelectorAll('input[placeholder="请输入产品功能"]'))
          .filter((node) => !node.disabled);
        copy.functions.forEach((value, index) => {
          if (features[index]) setValue(features[index], value);
        });
        return Boolean(features[0]);
      }, copy);
      await frameClick(page, (doc) => {
        const minimum = doc.querySelector('input[type="radio"][value="-1"]');
        if (!minimum || minimum.checked) return null;
        return minimum.closest("label") || minimum.closest(".el-radio") || minimum;
      });
      const completed = await page.evaluate((copy) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        const features = Array.from(doc.querySelectorAll('input[placeholder="请输入产品功能"]'))
          .filter((node) => !node.disabled);
        const server = doc.querySelector('input[placeholder^="服务器所在国家"]');
        const contact = doc.querySelector('textarea[placeholder="请输入自定义内容"]');
        if (server) setValue(server, copy.server);
        if (contact) setValue(contact, copy.contact);
        return Boolean(features[0] && server && contact);
      }, copy);
      if (!completed) throw new CommandExecutionError("Could not complete the no-data policy fields");
      await page.wait({ time: 2 });
      const contactOpened = await frameClick(page, (doc) => doc.querySelector("#addBusinessLinkId"));
      if (!contactOpened) throw new CommandExecutionError("Business-contact editor is unavailable");
      await page.wait({ time: 2 });
      await frameClick(page, (doc) => {
        const area = doc.querySelector("#addBusinessLinkId")?.parentElement;
        const rows = Array.from(area?.querySelectorAll(".cs-flex-start-center") || [])
          .filter((node) => node.querySelector(".el-select") && node.querySelector("input:not([role=combobox])"));
        const row = rows.at(-1);
        const select = row?.querySelector(".el-select");
        return select?.querySelector(".el-select__wrapper") || null;
      });
      const contactPrepared = await page.evaluate((email) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const area = doc?.querySelector("#addBusinessLinkId")?.parentElement;
        const rows = Array.from(area?.querySelectorAll(".cs-flex-start-center") || [])
          .filter((node) => node.querySelector(".el-select") && node.querySelector("input:not([role=combobox])"));
        const row = rows.at(-1);
        const select = row?.querySelector(".el-select");
        const input = row?.querySelector("input:not([role=combobox])");
        if (!select || !input) return false;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
        if (setter) setter.call(input, email);
        else input.value = email;
        input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
        input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
        return true;
      }, String(args.email));
      if (!contactPrepared) throw new CommandExecutionError("Could not prepare the privacy contact field");
      await page.wait({ time: 1 });
      const emailSelected = await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const option = Array.from(doc.querySelectorAll("li,[role=option]"))
          .find((node) => clean(node.innerText || node.textContent) === "邮箱");
        return option || null;
      });
      if (!emailSelected) throw new CommandExecutionError("Email contact type is unavailable");
      await page.wait({ time: 2 });
      const generated = await clickByTextWide(page, "生成协议");
      if (!generated) throw new CommandExecutionError("Generate protocol button is unavailable");
      await page.wait({ time: 4 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
          .find((node) => /生成协议|确认生成|发布协议/.test(clean(node.innerText)));
        const button = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => /^(确认|确定|生成)$/.test(clean(node.innerText || node.textContent))
            && !node.hasAttribute("disabled"));
        return button || null;
      });
      await page.wait({ time: 8 });
    }
    if (String(args.stage) === "update-permissions") {
      const permissions = declaredPermissions(cfg);
      if (permissions.length === 0) {
        throw new CommandExecutionError("No sensitive permissions declared in module.json5; skip this stage");
      }
      const firstPermission = permissions[0];
      const opened = await frameClick(page, (doc) => doc.querySelector("#addPermissionLinkId"));
      if (!opened) throw new CommandExecutionError("Permission editor is unavailable");
      await page.wait({ time: 3 });
      for (const permission of permissions) {
        const selected = await frameClick(page, (doc, win, vals) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const visible = (node) => {
            const style = doc.defaultView.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
            .filter(visible)
            .find((node) => clean(node.innerText).includes(vals.anchor));
          const input = Array.from(dialog?.querySelectorAll('input[type="checkbox"]') || [])
            .find((node) => clean(node.closest("label")?.innerText).includes(vals.wanted));
          if (!input || input.checked) return null;
          return input.closest("label") || input.closest(".el-checkbox") || input;
        }, { wanted: permission, anchor: firstPermission });
        if (!selected) {
          throw new CommandExecutionError(`Could not select declared permission: ${permission}`);
        }
        await page.wait({ time: 1 });
      }
      const confirmed = await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (node) => {
          const style = doc.defaultView.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
          .filter(visible)
          .find((node) => clean(node.innerText).includes(firstPermission));
        const confirm = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => clean(node.innerText || node.textContent) === "确认"
            && !node.hasAttribute("disabled"));
        return confirm || null;
      });
      if (!confirmed) throw new CommandExecutionError("Permission confirmation button is unavailable");
      await page.wait({ time: 3 });
      const reasonsFilled = await page.evaluate((copy) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const section = doc?.querySelector("#device-permission-info");
        const fields = Array.from(section?.querySelectorAll('textarea,input[maxlength="500"]') || [])
          .filter((node) => !node.disabled && node.getAttribute("placeholder") !== "产品简介");
        const reason = `${copy.functions[0] || "实现应用核心功能"}；相关数据仅在设备本地处理，不进行上传。`;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        for (const field of fields) setValue(field, reason);
        return fields.length;
      }, copy);
      if (reasonsFilled < 3) {
        throw new CommandExecutionError(`Expected at least 3 permission reason fields; found ${reasonsFilled}`);
      }
      await page.wait({ time: 3 });
      const saved = await clickByTextWide(page, "保存");
      if (!saved) throw new CommandExecutionError("Policy Save button is unavailable");
      await page.wait({ time: 6 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box'))
          .find((node) => /保存成功/.test(clean(node.innerText)));
        const button = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => /^(确认|确定)$/.test(clean(node.innerText || node.textContent))
            && !node.hasAttribute("disabled"));
        return button || null;
      });
      await page.wait({ time: 3 });
      const generated = await clickByTextWide(page, "生成协议");
      if (!generated) throw new CommandExecutionError("Generate protocol button is unavailable after saving");
      await page.wait({ time: 4 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
          .find((node) => /生成协议|确认生成|发布协议/.test(clean(node.innerText)));
        const button = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => /^(确认|确定|生成)$/.test(clean(node.innerText || node.textContent))
            && !node.hasAttribute("disabled"));
        return button || null;
      });
      await page.wait({ time: 10 });
    }
    if (String(args.stage) === "select-options") {
      const openedSelect = await frameClick(page, (doc) => {
        const inputs = Array.from(doc.querySelectorAll('input[role="combobox"]'))
          .filter((node) => !node.disabled);
        const input = inputs[1];
        return input?.closest(".el-select")?.querySelector(".el-select__wrapper") || null;
      });
      if (!openedSelect) throw new CommandExecutionError("Service-mode select is unavailable");
      await page.wait({ time: 2 });
    }
    if (String(args.stage) === "contact-options") {
      const openedContactSelect = await frameClick(page, (doc) => {
        const selects = Array.from(doc.querySelectorAll(".el-select"))
          .filter((node) => !node.querySelector("input")?.disabled);
        const select = selects.find((node) => node.parentElement?.parentElement?.querySelector(
          'textarea[placeholder="请输入自定义内容"]',
        ));
        return select?.querySelector(".el-select__wrapper") || null;
      });
      if (!openedContactSelect) throw new CommandExecutionError("Business-contact type select is unavailable");
      await page.wait({ time: 2 });
    }
    if (["core-select", "permission-dialog", "contact-dialog", "complete-draft"].includes(String(args.stage))) {
      const filled = await page.evaluate((copy) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        const intro = doc.querySelector('input[placeholder="产品简介"]');
        const path = Array.from(doc.querySelectorAll('input[placeholder="请输入应用内服务模式设置页面路径"]'))
          .find((node) => !node.disabled);
        if (!intro || !path) return false;
        setValue(intro, copy.intro);
        setValue(path, copy.path);
        return true;
      }, copy);
      if (!filled) throw new CommandExecutionError("Could not fill the policy introduction fields");
      await page.wait({ time: 1 });
      await frameClickWide(page, (doc) => {
        const inputs = Array.from(doc.querySelectorAll('input[role="combobox"]'))
          .filter((node) => !node.disabled);
        const input = inputs[1];
        return input?.closest(".el-select")?.querySelector(".el-select__wrapper") || null;
      });
      const selected = await frameClickWide(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const option = Array.from(doc.querySelectorAll("li,[role=option]"))
          .find((node) => clean(node.innerText || node.textContent) === "不收集个人信息");
        return option || null;
      });
      if (!selected) throw new CommandExecutionError("No-personal-information option is unavailable");
      await page.wait({ time: 3 });
      await page.evaluate((copy) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
        };
        const fields = Array.from(doc.querySelectorAll('input[placeholder="请输入产品功能"]'))
          .filter((node) => !node.disabled);
        copy.functions.forEach((value, index) => {
          if (fields[index]) setValue(fields[index], value);
        });
      }, copy);
      await page.wait({ time: 2 });
      if (["permission-dialog", "contact-dialog", "complete-draft"].includes(String(args.stage))) {
        const sensitivePermissions = declaredPermissions(cfg);
        const anchor = sensitivePermissions[0] || "";
        if (sensitivePermissions.length > 0) {
          const opened = await frameClick(page, (doc) => doc.querySelector("#addPermissionLinkId"));
          if (!opened) throw new CommandExecutionError("Permission editor is unavailable");
          await page.wait({ time: 3 });
        }
        if (["contact-dialog", "complete-draft"].includes(String(args.stage))) {
          if (sensitivePermissions.length > 0) {
          const wanted = new Set(sensitivePermissions);
          const selectedPermissions = await page.evaluate((input) => {
            const doc = document.querySelector("#mainIframeView")?.contentDocument;
            const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
            const dialog = Array.from(doc?.querySelectorAll('[role="dialog"],.el-dialog') || [])
              .find((node) => clean(node.innerText).includes(input.anchor));
            if (!dialog) return { ok: false, count: 0, toggles: [] };
            let count = 0;
            const toggles = [];
            for (const box of Array.from(dialog.querySelectorAll('input[type="checkbox"]'))) {
              const label = clean(box.closest("label")?.innerText);
              const permission = label.match(/ohos\.permission\.[A-Z_]+/)?.[0] || "";
              const shouldCheck = input.wanted.has(permission);
              if (box.checked !== shouldCheck) toggles.push({ permission, shouldCheck });
              if (shouldCheck) count += 1;
            }
            const confirm = Array.from(dialog.querySelectorAll("button"))
              .find((node) => clean(node.innerText || node.textContent) === "确认");
            if (!confirm || count !== input.wanted.size) return { ok: false, count, toggles: [] };
            return { ok: true, count, toggles };
          }, { wanted, anchor });
          if (!selectedPermissions.ok) {
            throw new CommandExecutionError(`Could not select all declared permissions (${selectedPermissions.count}/${wanted.size})`);
          }
          for (const item of selectedPermissions.toggles) {
            await frameClick(page, (doc, win, vals) => {
              const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
              const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
                .find((node) => clean(node.innerText).includes(vals.anchor));
              const input = Array.from(dialog?.querySelectorAll('input[type="checkbox"]') || [])
                .find((node) => clean(node.closest("label")?.innerText).includes(vals.permission));
              if (!input || input.checked === vals.shouldCheck) return null;
              return input.closest("label") || input.closest(".el-checkbox") || input;
            }, { permission: item.permission, shouldCheck: item.shouldCheck, anchor });
          }
          await frameClick(page, (doc) => {
            const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
            const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
              .find((node) => clean(node.innerText).includes(anchor));
            const confirm = Array.from(dialog?.querySelectorAll("button") || [])
              .find((node) => clean(node.innerText || node.textContent) === "确认"
                && !node.hasAttribute("disabled"));
            return confirm || null;
          });
          await page.wait({ time: 3 });
          }
          await frameClick(page, (doc) => {
            const minimum = doc.querySelector('input[type="radio"][value="-1"]');
            if (!minimum || minimum.checked) return null;
            return minimum.closest("label") || minimum.closest(".el-radio") || minimum;
          });
          const completed = await page.evaluate((copy) => {
            const doc = document.querySelector("#mainIframeView")?.contentDocument;
            const setValue = (node, value) => {
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
              if (setter) setter.call(node, value);
              else node.value = value;
              node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
              node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
              node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
            };
            const server = doc.querySelector('input[placeholder^="服务器所在国家"]');
            const contact = doc.querySelector('textarea[placeholder="请输入自定义内容"]');
            if (!server || !contact) return false;
            setValue(server, copy.server);
            setValue(contact, copy.contact);
            return true;
          }, copy);
          if (!completed) throw new CommandExecutionError("Could not complete storage and contact disclosures");
          await page.wait({ time: 3 });
          if (String(args.stage) === "complete-draft" && String(args.email || "").includes("@")) {
            const openedContact = await frameClick(page, (doc) => doc.querySelector("#addBusinessLinkId"));
            if (!openedContact) throw new CommandExecutionError("Business-contact editor is unavailable");
            await page.wait({ time: 2 });
            await frameClick(page, (doc) => {
              const area = doc.querySelector("#addBusinessLinkId")?.parentElement;
              const rows = Array.from(area?.querySelectorAll(".cs-flex-start-center") || [])
                .filter((node) => node.querySelector(".el-select") && node.querySelector("input:not([role=combobox])"));
              const row = rows.at(-1);
              const select = row?.querySelector(".el-select");
              return select?.querySelector(".el-select__wrapper") || null;
            });
            const contactPrepared = await page.evaluate((email) => {
              const doc = document.querySelector("#mainIframeView")?.contentDocument;
              const area = doc?.querySelector("#addBusinessLinkId")?.parentElement;
              const rows = Array.from(area?.querySelectorAll(".cs-flex-start-center") || [])
                .filter((node) => node.querySelector(".el-select") && node.querySelector("input:not([role=combobox])"));
              const row = rows.at(-1);
              const select = row?.querySelector(".el-select");
              const input = row?.querySelector("input:not([role=combobox])");
              if (!select || !input) return false;
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
              if (setter) setter.call(input, email);
              else input.value = email;
              input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
              input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
              return true;
            }, String(args.email));
            if (!contactPrepared) throw new CommandExecutionError("Could not prepare the privacy contact field");
            await page.wait({ time: 1 });
            const selectedEmail = await frameClick(page, (doc) => {
              const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
              const option = Array.from(doc.querySelectorAll("li,[role=option]"))
                .find((node) => clean(node.innerText || node.textContent) === "邮箱");
              return option || null;
            });
            if (!selectedEmail) throw new CommandExecutionError("Email contact type is unavailable");
            await page.wait({ time: 2 });
          }
          if (String(args.stage) === "contact-dialog") {
            const openedContact = await frameClick(page, (doc) => doc.querySelector("#addBusinessLinkId"));
            if (!openedContact) throw new CommandExecutionError("Business-contact editor is unavailable");
            await page.wait({ time: 3 });
          }
          const generated = String(args.stage) !== "complete-draft" || await clickByTextWide(page, "生成协议");
          if (!generated) throw new CommandExecutionError("Generate protocol button is unavailable");
          if (String(args.stage) === "complete-draft") await page.wait({ time: 5 });
        }
      }
    }
    if (String(args.stage) === "validate") {
      const clicked = await clickByTextWide(page, "生成协议");
      if (!clicked) throw new CommandExecutionError("Generate protocol button is unavailable");
      await page.wait({ time: 4 });
    }
    if (String(args.stage) === "save-current") {
      const anchor = declaredPermissions(cfg)[0] || "";
      if (anchor) {
        await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const permissionDialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
            .find((node) => clean(node.innerText).includes(anchor));
          const confirm = Array.from(permissionDialog?.querySelectorAll("button") || [])
            .find((node) => clean(node.innerText || node.textContent) === "确认"
              && !node.hasAttribute("disabled"));
          return confirm || null;
        });
      }
      const saved = await clickByTextWide(page, "保存");
      if (!saved) throw new CommandExecutionError("Policy Save button is unavailable");
      await page.wait({ time: 6 });
    }
    if (String(args.stage) === "publish") {
      if (!String(args.email || "").includes("@")) {
        throw new CommandExecutionError("A valid privacy contact email is required");
      }
      const anchor = declaredPermissions(cfg)[0] || "";
      if (anchor) {
        await frameClick(page, (doc) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const permissionDialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
            .find((node) => clean(node.innerText).includes(anchor));
          const confirm = Array.from(permissionDialog?.querySelectorAll("button") || [])
            .find((node) => clean(node.innerText || node.textContent) === "确认"
              && !node.hasAttribute("disabled"));
          return confirm || null;
        });
      }
      await frameClick(page, (doc) => {
        const contactArea = doc.querySelector("#addBusinessLinkId")?.parentElement;
        const select = contactArea?.querySelector(".el-select");
        return select?.querySelector(".el-select__wrapper") || null;
      });
      const prepared = await page.evaluate((email) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const contactArea = doc.querySelector("#addBusinessLinkId")?.parentElement;
        const select = contactArea?.querySelector(".el-select");
        const input = contactArea?.querySelector('.cs-flex-start-center input:not([role="combobox"])');
        if (!select || !input) return false;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
        if (setter) setter.call(input, email);
        else input.value = email;
        input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
        input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
        return true;
      }, String(args.email));
      if (!prepared) throw new CommandExecutionError("Could not prepare the privacy contact field");
      await page.wait({ time: 1 });
      const selectedEmail = await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const option = Array.from(doc.querySelectorAll("li,[role=option]"))
          .find((node) => clean(node.innerText || node.textContent) === "邮箱");
        return option || null;
      });
      if (!selectedEmail) throw new CommandExecutionError("Email contact type is unavailable");
      await page.wait({ time: 2 });
      const generated = await clickByTextWide(page, "生成协议");
      if (!generated) throw new CommandExecutionError("Generate protocol button is unavailable");
      await page.wait({ time: 4 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-message-box,.el-dialog'))
          .find((node) => /生成协议|确认生成|发布协议/.test(clean(node.innerText)));
        const button = Array.from(dialog?.querySelectorAll("button") || [])
          .find((node) => /^(确认|确定|生成)$/.test(clean(node.innerText || node.textContent))
            && !node.hasAttribute("disabled"));
        return button || null;
      });
      await page.wait({ time: 8 });
    }
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const win = doc?.defaultView;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const style = win.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return {
        body: clean(doc?.body?.innerText).slice(0, 24000),
        permissionHTML: doc?.querySelector("#addPermissionLinkId")?.closest("section")?.outerHTML.slice(0, 30000) || "",
        dialogs: Array.from(doc?.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box') || [])
          .filter(visible)
          .map((node) => clean(node.innerText).slice(0, 5000)),
        errors: Array.from(doc?.querySelectorAll(".el-form-item__error,.error-message,[role=alert]") || [])
          .filter(visible)
          .map((node) => clean(node.innerText || node.textContent).slice(0, 2000)),
        actions: Array.from(doc?.querySelectorAll("*") || [])
          .filter((node) => visible(node)
            && /^(增加|添加)/.test(clean(node.innerText || node.textContent))
            && !Array.from(node.children).some((child) => /^(增加|添加)/.test(clean(child.innerText || child.textContent))))
          .slice(0, 100)
          .map((node) => ({
            text: clean(node.innerText || node.textContent).slice(0, 500),
            tag: node.tagName.toLowerCase(),
            className: clean(node.className).slice(0, 500),
            outerHTML: node.outerHTML.slice(0, 3000),
            parent: node.parentElement?.outerHTML.slice(0, 6000) || "",
          })),
        controls: Array.from(doc?.querySelectorAll("input,textarea,button,[role=button]") || [])
          .filter(visible)
          .slice(0, 300)
          .map((node, index) => ({
            index,
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute("type") || "",
            value: clean(node.value).slice(0, 500),
            text: clean(node.innerText || node.textContent).slice(0, 300),
            placeholder: node.getAttribute("placeholder") || "",
            checked: Boolean(node.checked),
            disabled: Boolean(node.disabled),
            context: clean(node.closest("label,.el-form-item,section,div")?.innerText).slice(0, 1000),
            outerHTML: node.outerHTML.slice(0, 2000),
            parentHTML: node.parentElement?.parentElement?.outerHTML.slice(0, 5000) || "",
          })),
      };
    });
    return [{ status: "editor_ready", ...state }];
  },
});
