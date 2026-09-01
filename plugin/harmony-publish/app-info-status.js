import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, AGC_HOME, APP_INFO_ROUTE, projectConfig, resolveAppId } from "./shared.js";


cli({
  site: SITE,
  name: "app-info-status-ui",
  description: "UI fallback for inspecting saved AppGallery application information",
  access: "read",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  columns: ["status", "controls", "errors", "body"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const APP_INFO_URL = `${AGC_HOME}#/myApp/${await resolveAppId(page, cfg)}/${APP_INFO_ROUTE}`;
    await page.goto(APP_INFO_URL, { waitUntil: "load", settleMs: 4000 });
    await page.wait({ time: 7 });
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const style = doc.defaultView.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return {
        requiredFields: Array.from(doc?.querySelectorAll(".el-form-item.is-required,[aria-required=true]") || [])
          .map((node, index) => ({
            index,
            label: clean(node.querySelector(".el-form-item__label,label")?.innerText),
            text: clean(node.innerText).slice(0, 3000),
            values: Array.from(node.querySelectorAll("input,textarea"))
              .map((field) => clean(field.value))
              .filter(Boolean),
            hasImage: Boolean(node.querySelector("img.avatar")),
            html: node.outerHTML.slice(0, 12000),
          })),
        controls: Array.from(doc?.querySelectorAll("input,textarea,button,a,[role=button],[role=combobox]") || [])
          .filter(visible)
          .map((node, index) => ({
            index,
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute("type") || "",
            id: node.id || "",
            value: clean(node.value).slice(0, 1000),
            text: clean(node.innerText || node.textContent).slice(0, 1000),
            placeholder: node.getAttribute("placeholder") || "",
            checked: Boolean(node.checked),
            disabled: Boolean(node.disabled),
            context: clean(node.closest(".el-form-item,.form-item,section,tr,li,div")?.innerText).slice(0, 1800),
            outerHTML: node.outerHTML.slice(0, 3500),
          })),
        errors: Array.from(doc?.querySelectorAll(".el-form-item__error,.error-message,[role=alert]") || [])
          .filter(visible)
          .map((node) => clean(node.innerText || node.textContent))
          .filter(Boolean),
        iconCount: doc?.querySelectorAll('img[src*="appgallery"],img.avatar').length || 0,
        body: clean(doc?.body?.innerText).slice(0, 16000),
      };
    });
    return [{ status: "inspected", ...state }];
  },
});
