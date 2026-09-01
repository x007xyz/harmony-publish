import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, navigateVersionPage, projectConfig } from "./shared.js";


cli({
  site: SITE,
  name: "version-inspect-ui",
  description: "UI fallback for inspecting the project AppGallery version state",
  access: "read",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  columns: ["status", "body", "controls"],
  func: async (page) => {
    await navigateVersionPage(page, cfg);
    await page.wait({ time: 7 });
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const win = doc?.defaultView;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const style = win.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const controls = Array.from(doc?.querySelectorAll("input,textarea,button,a,[role=button],[role=combobox]") || [])
        .filter(visible)
        .slice(0, 500)
        .map((node, index) => ({
          index,
          tag: node.tagName.toLowerCase(),
          type: node.getAttribute("type") || "",
          id: node.id || "",
          name: node.getAttribute("name") || "",
          value: clean(node.value).slice(0, 500),
          text: clean(node.innerText || node.textContent).slice(0, 500),
          placeholder: node.getAttribute("placeholder") || "",
          checked: Boolean(node.checked),
          disabled: Boolean(node.disabled),
          context: clean(node.closest(".el-form-item,.form-item,section,tr,li,div")?.innerText).slice(0, 1600),
          outerHTML: node.outerHTML.slice(0, 2500),
        }));
      return {
        body: clean(doc?.body?.innerText).slice(0, 30000),
        permissionRows: Array.from(doc?.querySelectorAll("tr") || [])
          .filter((node) => /模糊位置|确切位置信息|相机|媒体位置/.test(clean(node.innerText)))
          .map((node, index) => ({
            index,
            text: clean(node.innerText).slice(0, 4000),
            outerHTML: node.outerHTML.slice(0, 16000),
            fields: Array.from(node.querySelectorAll("input,textarea"))
              .map((field) => ({
                tag: field.tagName.toLowerCase(),
                id: field.id || "",
                value: clean(field.value).slice(0, 1000),
                placeholder: field.getAttribute("placeholder") || "",
                disabled: Boolean(field.disabled),
                outerHTML: field.outerHTML.slice(0, 3000),
              })),
          })),
        controls,
        dialogs: Array.from(doc?.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box') || [])
          .filter(visible)
          .map((node) => clean(node.innerText).slice(0, 6000)),
      };
    });
    return [{ status: "inspected", ...state }];
  },
});
