import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, navigateVersionPage, projectConfig } from "./shared.js";


cli({
  site: SITE,
  name: "screenshot-status-ui",
  description: "UI fallback for inspecting AppGallery screenshot state",
  access: "read",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  columns: ["status", "thumbnailCount", "inputs", "errors", "html"],
  func: async (page) => {
    await navigateVersionPage(page, cfg);
    await page.wait({ time: 7 });
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const nodes = Array.from(doc?.querySelectorAll("section,.el-form-item,div") || [])
        .filter((node) => {
          const text = clean(node.innerText);
          return text.includes("应用截图和视频") && text.includes("竖向截图") && node.querySelector('input[type="file"]');
        })
        .sort((a, b) => clean(a.innerText).length - clean(b.innerText).length);
      const root = nodes[0] || doc?.body;
      const thumbnails = Array.from(root?.querySelectorAll('img[id*="screenShotsImg"],img.avatar') || []);
      return {
        thumbnailCount: thumbnails.length,
        thumbnails: thumbnails.map((node) => ({
          id: node.id || "",
          src: String(node.src || "").slice(0, 1200),
          parentHTML: node.parentElement?.outerHTML.slice(0, 8000) || "",
        })),
        inputs: Array.from(root?.querySelectorAll('input[type="file"]') || []).map((node, index) => ({
          index,
          id: node.id || "",
          accept: node.accept || "",
          multiple: Boolean(node.multiple),
          parentHTML: node.parentElement?.outerHTML.slice(0, 8000) || "",
        })),
        errors: Array.from(root?.querySelectorAll(".el-form-item__error,[role=alert]") || [])
          .filter((node) => doc.defaultView.getComputedStyle(node).display !== "none")
          .map((node) => clean(node.innerText || node.textContent))
          .filter(Boolean),
        html: root?.outerHTML.slice(0, 40000) || "",
      };
    });
    return [{ status: "inspected", ...state }];
  },
});
