import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, AGC_HOME, VERSION_ROUTE, clickByText, frameClick, projectConfig, resolveAppId, findLatestApp, inspectApp, projectPath } from "./shared.js";


cli({
  site: SITE,
  name: "upload-package-ui",
  description: "UI fallback for uploading a verified signed APP when the official Upload API is unavailable",
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
    { name: "app", default: "", help: "Signed APP file; defaults to the newest signed build" },
  ],
  columns: ["status", "artifact", "version", "sha256", "detail"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const PACKAGE_URL = `${AGC_HOME}#/myApp/${await resolveAppId(page, cfg)}/${VERSION_ROUTE}`;
    const project = projectPath(args.project);
    const artifact = inspectApp(String(args.app || "").trim() || findLatestApp(project));
    if (!artifact.signed) throw new CommandExecutionError("Refusing to upload an unsigned APP package");

    await page.goto(PACKAGE_URL, { waitUntil: "load", settleMs: 4000 });
    await page.wait({ time: 6 });
    const ready = await clickByText(page, "上传");
    if (!ready) throw new CommandExecutionError("Upload button is unavailable");
    await page.wait({ time: 2 });

    const prepared = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const target = doc?.querySelector('input[type="file"][accept*=".app"]');
      if (!target) return false;
      const formalRadio = Array.from(doc.querySelectorAll('input[type="radio"]'))
        .find((node) => String(node.closest("label,div")?.innerText || "").includes("测试和正式上架"));
      return { formalNeedsClick: Boolean(formalRadio && !formalRadio.checked) };
      document.querySelector("#opencli-agc-upload-proxy")?.remove();
      const proxy = document.createElement("input");
      proxy.type = "file";
      proxy.id = "opencli-agc-upload-proxy";
      proxy.accept = ".app";
      proxy.style.position = "fixed";
      proxy.style.left = "0";
      proxy.style.top = "0";
      proxy.style.zIndex = "2147483647";
      document.body.appendChild(proxy);
      return { fileInputReady: true };
    });
    if (!prepared?.fileInputReady) throw new CommandExecutionError("APP file input is unavailable after opening the upload dialog");
    if (prepared.formalNeedsClick) {
      const formalPicked = await frameClick(page, (doc) => {
        const radio = Array.from(doc.querySelectorAll('input[type="radio"]'))
          .find((node) => String(node.closest("label,div")?.innerText || "").includes("测试和正式上架"));
        if (!radio || radio.checked) return null;
        return radio.closest("label") || radio.closest(".el-radio") || radio;
      });
      if (!formalPicked) throw new CommandExecutionError("Formal release radio is unavailable");
      await page.wait({ time: 1 });
    }

    const uploaded = await page.uploadFiles("#opencli-agc-upload-proxy", [artifact.path]);
    if (!uploaded?.uploaded || uploaded.files !== 1) {
      throw new CommandExecutionError("OpenCLI did not confirm selection of one APP file");
    }
    const transferred = await page.evaluate(() => {
      const proxy = document.querySelector("#opencli-agc-upload-proxy");
      const frame = document.querySelector("#mainIframeView");
      const doc = frame?.contentDocument;
      const target = doc?.querySelector('input[type="file"][accept*=".app"]');
      if (!proxy?.files?.length || !target) return false;
      const transfer = new DataTransfer();
      for (const file of proxy.files) transfer.items.add(file);
      target.files = transfer.files;
      const EventCtor = frame.contentWindow.Event;
      target.dispatchEvent(new EventCtor("input", { bubbles: true }));
      target.dispatchEvent(new EventCtor("change", { bubbles: true }));
      proxy.remove();
      return target.files.length === 1;
    });
    if (!transferred) throw new CommandExecutionError("Could not transfer the selected APP into the AGC iframe");

    await page.wait({ time: 12 });
    const result = await page.evaluate((filename) => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const text = String(doc?.body?.innerText || "").replace(/\s+/g, " ").trim();
      return {
        text: text.slice(0, 12000),
        confirmed: text.includes(filename) || /上传成功|检测中|解析中|解析包|处理中/.test(text),
      };
    }, artifact.filename);
    if (!result.confirmed) {
      throw new CommandExecutionError(`AGC upload was not confirmed: ${result.text.slice(-1200)}`);
    }
    return [{
      status: "uploaded",
      artifact: artifact.filename,
      version: `${artifact.versionName} (${artifact.versionCode})`,
      sha256: artifact.sha256,
      detail: result.text.slice(-1200),
    }];
  },
});
