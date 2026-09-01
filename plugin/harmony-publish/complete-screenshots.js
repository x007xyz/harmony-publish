import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, clickByText, frameClick, loadMetadata, navigateVersionPage, projectPath, projectConfig, metadataPath } from "./shared.js";


cli({
  site: SITE,
  name: "complete-screenshots-ui",
  description: "UI fallback for uploading AppGallery screenshots",
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
    { name: "metadata", default: "", help: "AppGallery metadata JSON" },
  ],
  columns: ["status", "before", "after", "saved", "detail"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const project = projectPath(args.project);
    const metadata = loadMetadata(args.metadata || metadataPath(cfg)).data;
    const screenshots = (metadata.screenshots || []).map((item) => resolve(project, item));
    if (screenshots.length < 3 || screenshots.length > 5) {
      throw new CommandExecutionError("AppGallery requires 3-5 screenshots");
    }
    const missingFiles = screenshots.filter((path) => !existsSync(path));
    if (missingFiles.length) throw new CommandExecutionError(`Missing screenshot(s): ${missingFiles.join(", ")}`);

    await navigateVersionPage(page, cfg);
    await page.wait({ time: 7 });
    const count = async () => page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      return doc?.querySelectorAll('#pane-screenShots img[id*="screenShotsImg"].avatar').length || 0;
    });
    const before = await count();
    if (before > screenshots.length) {
      throw new CommandExecutionError(`Store has ${before} screenshots, more than metadata declares (${screenshots.length})`);
    }
    for (let index = before; index < screenshots.length; index += 1) {
      const proxyId = `opencli-agc-missing-screenshot-${index}`;
      const ready = await page.evaluate((id) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const target = Array.from(doc?.querySelectorAll('#pane-screenShots input[type="file"]') || [])
          .find((node) => /png|jpe?g|webp/i.test(node.accept || "")
            && !node.closest(".appinfo-screenshots-uploader")?.querySelector("img.avatar"));
        if (!target) return false;
        target.id = id;
        document.body.appendChild(target);
        return true;
      }, proxyId);
      if (!ready) throw new CommandExecutionError(`Empty screenshot slot ${index + 1} is unavailable`);
      const uploaded = await page.uploadFiles(`#${proxyId}`, [screenshots[index]]);
      if (!uploaded?.uploaded || uploaded.files !== 1) {
        throw new CommandExecutionError(`OpenCLI did not upload screenshot ${index + 1}`);
      }
      await page.wait({ time: 8 });
      const current = await count();
      if (current !== index + 1) {
        throw new CommandExecutionError(`Screenshot ${index + 1} was selected but stored count is ${current}`);
      }
    }
    const saved = await clickByText(page, "保存");
    if (!saved) throw new CommandExecutionError("Version Save button is unavailable after screenshot upload");
    await page.wait({ time: 5 });
    await frameClick(page, (doc) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box'))
        .find((node) => clean(node.innerText).includes("软件包可支持分发的设备范围"));
      const ignore = Array.from(dialog?.querySelectorAll("button") || [])
        .find((node) => clean(node.innerText || node.textContent) === "忽略" && !node.hasAttribute("disabled"));
      return ignore || null;
    });
    await page.wait({ time: 10 });
    const after = await count();
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      return clean(doc?.body?.innerText).slice(-5000);
    });
    if (after !== screenshots.length || !/保存成功/.test(state)) {
      throw new CommandExecutionError(`Screenshot save could not be verified: count=${after}`);
    }
    return [{
      status: "completed",
      before,
      after,
      saved: true,
      detail: `${after} vertical screenshots stored and version save confirmed`,
    }];
  },
});
