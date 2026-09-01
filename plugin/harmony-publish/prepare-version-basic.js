import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, clickByText, frameClick, loadMetadata, navigateVersionPage, projectPath, projectConfig, metadataPath } from "./shared.js";


cli({
  site: SITE,
  name: "prepare-version-basic-ui",
  description: "UI fallback for version metadata when the official Publishing API is unavailable",
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
    { name: "metadata", default: "", help: "AppGallery metadata JSON (defaults to <project>/release/appgallery.metadata.json)" },
    { name: "package-name", default: "", help: "Signed APP filename (defaults to projects.json packageName)" },
    { name: "package-version", default: "", help: "Package version (defaults to projects.json packageVersion)" },
  ],
  columns: ["status", "package", "countries", "screenshots", "detail"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const project = projectPath(args.project);
    const PACKAGE_NAME = String(args["package-name"] || cfg.packageName || "ohos-release-signed.app");
    const PACKAGE_VERSION = String(args["package-version"] || cfg.packageVersion || "");
    const metadata = loadMetadata(args.metadata || metadataPath(cfg)).data;
    const description = metadata.description?.["zh-CN"];
    const brief = metadata.shortDescription?.["zh-CN"];
    const screenshots = (metadata.screenshots || []).map((item) => resolve(project, item));
    if (!description || !brief) throw new CommandExecutionError("Chinese description and short description are required");
    if (brief.length > 17) throw new CommandExecutionError(`Short description exceeds 17 characters: ${brief.length}`);
    if (screenshots.length < 3 || screenshots.length > 5) {
      throw new CommandExecutionError("AppGallery requires 3-5 screenshots");
    }
    const missing = screenshots.filter((path) => !existsSync(path));
    if (missing.length) throw new CommandExecutionError(`Missing screenshot(s): ${missing.join(", ")}`);

    await navigateVersionPage(page, cfg);
    await page.wait({ time: 6 });
    await choosePackage(page);
    await selectMainlandChina(page);

    const filled = await page.evaluate((values) => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      if (!doc) return false;
      const setValue = (node, value) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
        if (setter) setter.call(node, value);
        else node.value = value;
        node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
        node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      };
      const description = doc.querySelector("#AppInfoAppIntroduceInputBox");
      const brief = doc.querySelector("#AppInfoAppBriefInputBox");
      if (!description || !brief) return false;
      setValue(description, values.description);
      setValue(brief, values.brief);
      const remarks = Array.from(doc.querySelectorAll("textarea"))
        .find((node) => node !== description && Number(node.getAttribute("maxlength") || 300) <= 300);
      if (remarks) setValue(remarks, values.remarks);
      return true;
    }, { description, brief, remarks: cfg.remarks });
    if (!filled) throw new CommandExecutionError("Could not fill the localized version fields");
    // 截图方向 / 数据不涉及 / 单机APP 三个 radio:CDP 真实点击 label(合成 click 无效)
    for (const label of ["竖向截图", "不涉及", "单机APP"]) {
      const picked = await clickByText(page, label, {}, { exact: false, skipChecked: true });
      if (!picked) throw new CommandExecutionError(`Version form radio is unavailable: ${label}`);
      await page.wait({ time: 1 });
    }
    await page.wait({ time: 2 });

    for (let index = 0; index < screenshots.length; index += 1) {
      await uploadScreenshot(page, screenshots[index], index);
      await page.wait({ time: 4 });
    }

    const save = await clickByText(page, "保存");
    if (!save) throw new CommandExecutionError("Version draft Save button is unavailable");
    await page.wait({ time: 6 });
    const result = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const text = String(doc?.body?.innerText || "").replace(/\s+/g, " ").trim();
      const errors = Array.from(doc?.querySelectorAll(".el-form-item__error,.error-message,[role=alert]") || [])
        .map((node) => String(node.innerText || node.textContent).trim())
        .filter(Boolean);
      return { text: text.slice(0, 9000), errors };
    });
    const blocking = result.errors.filter((message) => !/重新填写调查问卷/.test(message));
    if (blocking.length) throw new CommandExecutionError(`AGC rejected the version draft: ${blocking.join("; ")}`);
    return [{
      status: /保存成功/.test(result.text) ? "saved" : "prepared",
      package: PACKAGE_NAME,
      countries: "中国大陆",
      screenshots: screenshots.length,
      detail: "Basic version draft prepared; privacy, rating, and reviewer contact remain",
    }];
  },
});

async function choosePackage(page) {
  const opened = await clickByText(page, "版本选取");
  if (!opened) throw new CommandExecutionError("Version package picker is unavailable");
  await page.wait({ time: 2 });
  const selected = await frameClick(page, (doc, win, vals) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const dialog = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog'))
      .find((node) => String(node.innerText || "").includes("版本选取"));
    const row = Array.from(dialog?.querySelectorAll("tbody tr") || [])
      .find((node) => {
        const text = String(node.innerText || "");
        return text.includes(vals.filename) && text.includes(vals.version);
      });
    if (!row) return null;
    const radio = row.querySelector('input[type="radio"]');
    if (!radio) return null;
    if (radio.checked) return null;
    return radio.closest("label") || row.querySelector(".el-radio") || radio;
  }, { filename: PACKAGE_NAME, version: PACKAGE_VERSION });
  if (!selected) throw new CommandExecutionError(`Uploaded package is unavailable: ${PACKAGE_NAME}`);
  await page.wait({ time: 1 });
  const confirmed = await clickByText(page, "确认选取", {}, { exact: false });
  if (!confirmed) throw new CommandExecutionError("Could not confirm the signed package selection");
  await page.wait({ time: 3 });
}

async function selectMainlandChina(page) {
  const specific = await frameClick(page, (doc) => {
    const radio = Array.from(doc.querySelectorAll('input[type="radio"]'))
      .find((node) => node.value === "SPECIFIC");
    if (!radio || radio.checked) return null;
    return radio.closest("label") || radio.closest(".el-radio") || radio;
  });
  if (!specific) throw new CommandExecutionError("Specific-country release option is unavailable");
  await page.wait({ time: 2 });
  const chosen = await frameClick(page, (doc) => {
    const candidates = Array.from(doc.querySelectorAll('input[type="checkbox"]'))
      .filter((node) => String(node.closest("label,li,div")?.innerText || "").replace(/\s+/g, " ").trim() === "中国大陆");
    const checkbox = candidates.at(-1);
    if (!checkbox || checkbox.checked) return null;
    return checkbox.closest("label") || checkbox.closest(".el-checkbox") || checkbox;
  });
  if (!chosen) throw new CommandExecutionError("Mainland China country checkbox is unavailable");
  await page.wait({ time: 2 });
}

async function uploadScreenshot(page, path, index) {
  const id = `opencli-agc-screenshot-${index}`;
  const ready = await page.evaluate((targetId) => {
    const doc = document.querySelector("#mainIframeView")?.contentDocument;
    const inputs = Array.from(doc?.querySelectorAll('#pane-screenShots input[type="file"]') || [])
      .filter((node) => /png|jpe?g|webp/i.test(node.accept || "")
        && !node.closest(".appinfo-screenshots-uploader")?.querySelector("img.avatar"));
    const target = inputs[0];
    if (!target) return false;
    target.id = targetId;
    document.body.appendChild(target);
    return true;
  }, id);
  if (!ready) throw new CommandExecutionError(`Screenshot slot ${index + 1} is unavailable`);
  const upload = await page.uploadFiles(`#${id}`, [path]);
  if (!upload?.uploaded || upload.files !== 1) {
    throw new CommandExecutionError(`OpenCLI did not select screenshot ${index + 1}`);
  }
}
