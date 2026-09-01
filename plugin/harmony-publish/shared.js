import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = resolve(PLUGIN_DIR, "..", "..");
export const TOOLS_DIR = join(SKILL_DIR, "tools");
export const SITE = "harmony-publish";

export const AGC_HOME = "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html";
// Shared AGC SPA route IDs (identical across apps; only the APP ID differs).
export const APP_INFO_ROUTE = "9249519184596237673";
export const PROTOCOL_ROUTE = "172249065902862722";
export const VERSION_ROUTE = "172249065903274627";
export const HVIGOR = "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw";
export const OHPM = "/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm";
const HAP_SIGN_TOOL = "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar";
let projectsCache = null;

/** Read <skill>/projects.json once (keyed by project name). */
function loadProjects() {
  if (projectsCache) return projectsCache;
  const path = join(SKILL_DIR, "projects.json");
  if (!existsSync(path)) {
    throw new CommandExecutionError(`projects.json not found: ${path}`);
  }
  try {
    projectsCache = JSON.parse(readText(path));
  } catch (error) {
    throw new CommandExecutionError(`Invalid projects.json: ${error?.message || error}`);
  }
  return projectsCache;
}

/** Resolve a project by config key, absolute project path, or display name. */
function resolveProject(value) {
  const key = String(value || "").trim();
  const projects = loadProjects();
  if (!key) {
    throw new ArgumentError(
      `缺少 --project。可用项目: ${Object.keys(projects).join(", ")}`,
    );
  }
  if (projects[key]) return { key, ...projects[key] };
  const absolute = resolve(key);
  const byPath = Object.entries(projects).find(([, cfg]) => resolve(cfg.projectRoot) === absolute);
  if (byPath) return { key: byPath[0], ...byPath[1] };
  const byDisplay = Object.entries(projects).find(([, cfg]) => cfg.displayName === key);
  if (byDisplay) return { key: byDisplay[0], ...byDisplay[1] };
  throw new ArgumentError(
    `未知项目: ${key}。可用项目: ${Object.keys(projects).join(", ")}`,
  );
}

/** Resolve the project config from a command's parsed args (`--project`). */
export function projectConfig(args) {
  return resolveProject(args?.project);
}

/** HarmonyOS build directory: native root, or <root>/ohos for Flutter projects. */
export function projectDir(cfg) {
  return cfg.flutter ? join(cfg.projectRoot, "ohos") : cfg.projectRoot;
}

/** Release metadata path under the top-level project root. */
export function metadataPath(cfg) {
  return join(cfg.projectRoot, "release", "appgallery.metadata.json");
}

/** APP ID from config, falling back to the currently open AGC page URL. */
export async function resolveAppId(page, cfg) {
  if (cfg.appId) return cfg.appId;
  const found = await page.evaluate(() => {
    const match = String(location.hash || "").match(/\/myApp\/(\d{15,20})/);
    return match?.[1] || "";
  });
  if (found) return found;
  throw new CommandExecutionError(
    `appId 未配置(${cfg.key})。请先进入该应用的 AGC 控制台页面,或把 appId 写入 ${join(SKILL_DIR, "projects.json")}`,
  );
}

export async function navigateVersionPage(page, cfg) {
  const appId = await resolveAppId(page, cfg);
  await page.goto(`${AGC_HOME}#/myApp/${appId}/${VERSION_ROUTE}`, { waitUntil: "load", settleMs: 3000 });
  await page.wait({ time: 2 });
  const ok = await page.evaluate((route) => {
    const frame = document.querySelector("#mainIframeView");
    if (!frame) return false;
    frame.src = route;
    return true;
  }, `${AGC_HOME}/amp/?_=20260707211624#/distribute/appVersion/harmony`);
  if (!ok) throw new CommandExecutionError("AGC version iframe is unavailable");
  await page.wait({ time: 9 });
  return ok;
}

export function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  return /^(true|1|yes|y|on)$/i.test(String(value).trim());
}

export function projectPath(value) {
  const cfg = resolveProject(value);
  const path = projectDir(cfg);
  if (!existsSync(join(path, "AppScope", "app.json5"))) {
    throw new ArgumentError(`Not a HarmonyOS application project: ${path}`);
  }
  return path;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function capture(pattern, text, label) {
  const value = text.match(pattern)?.[1];
  if (value == null) throw new CommandExecutionError(`Could not read ${label}`);
  return value;
}

export function readAppInfo(project) {
  const appJson = readText(join(project, "AppScope", "app.json5"));
  const stringsPath = join(project, "entry", "src", "main", "resources", "base", "element", "string.json");
  const strings = existsSync(stringsPath) ? JSON.parse(readText(stringsPath)) : { string: [] };
  const appName = strings.string?.find((item) => item.name === "EntryAbility_label")?.value
    || strings.string?.find((item) => item.name === "app_name")?.value
    || "";
  return {
    bundleName: capture(/"bundleName"\s*:\s*"([^"]+)"/, appJson, "bundleName"),
    versionCode: Number(capture(/"versionCode"\s*:\s*(\d+)/, appJson, "versionCode")),
    versionName: capture(/"versionName"\s*:\s*"([^"]+)"/, appJson, "versionName"),
    vendor: capture(/"vendor"\s*:\s*"([^"]+)"/, appJson, "vendor"),
    appName,
  };
}

export function readSigningInfo(project) {
  const profilePath = join(project, "build-profile.json5");
  const text = readText(profilePath);
  const releaseBlock = objectContaining(text, /"name"\s*:\s*"release"/) || text;
  const pathFor = (name) => releaseBlock.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1] || "";
  return {
    profilePath,
    alias: pathFor("keyAlias"),
    certPath: pathFor("certpath"),
    provisionPath: pathFor("profile"),
    storePath: pathFor("storeFile"),
    embedsKeyPassword: /"keyPassword"\s*:\s*"[^"]+"/.test(releaseBlock),
    embedsStorePassword: /"storePassword"\s*:\s*"[^"]+"/.test(releaseBlock),
  };
}

function objectContaining(text, marker) {
  const markerIndex = text.search(marker);
  if (markerIndex < 0) return "";
  const start = text.lastIndexOf("{", markerIndex);
  if (start < 0) return "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

export function findLatestHap(project) {
  const root = join(project, "entry", "build");
  if (!existsSync(root)) return "";
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (name.endsWith("-signed.hap")) found.push({ path, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0]?.path || "";
}

export function findLatestApp(project) {
  const root = join(project, "build", "outputs");
  if (!existsSync(root)) return "";
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (name.endsWith("-signed.app")) found.push({ path, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0]?.path || "";
}

export function inspectHap(path) {
  if (!path || !existsSync(path)) throw new ArgumentError(`HAP not found: ${path || "(empty)"}`);
  let moduleJson;
  try {
    moduleJson = JSON.parse(execFileSync("/usr/bin/unzip", ["-p", path, "module.json"], { encoding: "utf8" }));
  } catch (error) {
    throw new CommandExecutionError(`Cannot read module.json from ${path}: ${error?.message || error}`);
  }
  const data = readFileSync(path);
  return {
    path,
    filename: basename(path),
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    app: moduleJson.app || {},
    module: moduleJson.module || {},
  };
}

export function inspectApp(path) {
  if (!path || !existsSync(path)) throw new ArgumentError(`APP package not found: ${path || "(empty)"}`);
  let packInfo;
  try {
    packInfo = JSON.parse(execFileSync("/usr/bin/unzip", ["-p", path, "pack.info"], { encoding: "utf8" }));
  } catch (error) {
    throw new CommandExecutionError(`Cannot read pack.info from ${path}: ${error?.message || error}`);
  }
  const data = readFileSync(path);
  const app = packInfo.summary?.app || {};
  return {
    path,
    filename: basename(path),
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    signed: /-signed\.app$/i.test(basename(path)),
    bundleName: app.bundleName || "",
    versionCode: app.version?.code,
    versionName: app.version?.name || "",
    modules: packInfo.summary?.modules || [],
  };
}

export function verifySignedPackage(path, project) {
  if (!existsSync(HAP_SIGN_TOOL)) {
    throw new CommandExecutionError(`DevEco signing verifier not found: ${HAP_SIGN_TOOL}`);
  }
  const outputDir = mkdtempSync(join(tmpdir(), "harmony-sign-verify-"));
  try {
    const output = runTool("java", [
      "-jar", HAP_SIGN_TOOL,
      "verify-app",
      "-inFile", path,
      "-outCertChain", join(outputDir, "cert-chain.cer"),
      "-outProfile", join(outputDir, "profile.p7b"),
      ...(path.toLowerCase().endsWith(".app") ? ["-inForm", "zip"] : []),
    ], project);
    if (!/verify-app success/i.test(output)) {
      throw new CommandExecutionError("DevEco signing verifier did not confirm package success");
    }
    return true;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

export function loadMetadata(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new ArgumentError(`AppGallery metadata file not found: ${resolved}`);
  try {
    return { path: resolved, data: JSON.parse(readText(resolved)) };
  } catch (error) {
    throw new ArgumentError(`Invalid AppGallery metadata JSON: ${error?.message || error}`);
  }
}

export function runTool(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new CommandExecutionError(`${basename(command)} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

export function checkReleaseSigning(signing) {
  const paths = [signing.certPath, signing.provisionPath, signing.storePath];
  const missing = paths.filter((path) => !path || !existsSync(path));
  const debugAlias = /debug/i.test(signing.alias);
  return {
    ok: missing.length === 0 && !debugAlias,
    debugAlias,
    missing,
  };
}

export function pngDimensions(path) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
// ---------------------------------------------------------------------------
// CDP 真实输入工具(AGC 复杂 iframe 嵌套场景)
// 原则:查找用 evaluate(按文本/结构,鲁棒),交互用 CDP 真实事件(isTrusted=true)
// find 函数签名:(doc, win, values) => element|null —— 在 mainIframeView 的
// contentDocument 内查找;其内部只能使用局部变量和 values,不能引用闭包变量。
// ---------------------------------------------------------------------------

async function locateInFrame(page, find, values, scroll, scrollBlock) {
  return page.evaluate((input) => {
    const { findSource, values: vals, doScroll, block } = input;
    const iframe = document.querySelector("#mainIframeView");
    if (!iframe) return null;
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return null;
    const findFn = new Function(`return (${findSource})`)();
    const el = findFn(doc, win, vals);
    if (!el) return null;
    if (doScroll) el.scrollIntoView({ block, inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const iframeRect = iframe.getBoundingClientRect();
    const innerX = rect.left + rect.width / 2;
    const innerY = rect.top + rect.height / 2;
    const topX = iframeRect.left + innerX;
    const topY = iframeRect.top + innerY;
    const innerTop = rect.width > 0 && rect.height > 0 ? doc.elementFromPoint(innerX, innerY) : null;
    const outerTop = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(topX, topY) : null;
    const innerClear = Boolean(innerTop && (innerTop === el || el.contains(innerTop) || innerTop.contains(el)));
    const outerClear = Boolean(outerTop && (outerTop === iframe || iframe.contains(outerTop)));
    const inFrameViewport = rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
    const inTopViewport = topY >= 0 && topX >= 0 && topY < window.innerHeight && topX < window.innerWidth;
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return {
      x: Math.round(topX),
      y: Math.round(topY),
      visible: rect.width > 0 && rect.height > 0 && inFrameViewport && inTopViewport,
      occluded: !innerClear || !outerClear,
      semantic: {
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: normalize(el.getAttribute("aria-label") || el.innerText || el.textContent).slice(0, 160),
      },
      paint: {
        innerTop: normalize(innerTop?.getAttribute?.("aria-label") || innerTop?.innerText || innerTop?.textContent || innerTop?.tagName).slice(0, 160),
        outerTop: normalize(outerTop?.getAttribute?.("aria-label") || outerTop?.innerText || outerTop?.textContent || outerTop?.tagName).slice(0, 160),
        innerClear,
        outerClear,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
    };
  }, { findSource: find.toString(), values, doScroll: scroll, block: scrollBlock });
}

/** 查找元素并滚动到视口中央,等待布局稳定后返回其顶层视口坐标(未找到返回 null) */
export async function framePoint(page, find, values = {}, opts = {}) {
  const { waitMs = 350, scrollBlock = "center", scroll = true } = opts;
  const first = await locateInFrame(page, find, values, scroll, scrollBlock);
  if (!first) return null;
  // opencli page.wait({ time }) 单位是秒(waitMs 为毫秒,转换)
  if (waitMs > 0) await page.wait({ time: Math.max(0.05, waitMs / 1000) });
  return locateInFrame(page, find, values, false, scrollBlock);
}

/** CDP 真实鼠标点击(顶层视口坐标,isTrusted=true) */
export async function cdpClick(page, x, y) {
  if (typeof page.nativeClick === "function") {
    await page.nativeClick(x, y);
    return;
  }
  if (!page.cdp) throw new CommandExecutionError("CDP is unavailable; the Browser Bridge extension may be too old");
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function armFrameEventProbe(page) {
  return page.evaluate(() => {
    const win = document.querySelector("#mainIframeView")?.contentWindow;
    const doc = win?.document;
    if (!win || !doc) return false;
    win.__opencliTrustedEventProbe = [];
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      doc.addEventListener(type, (event) => {
        win.__opencliTrustedEventProbe.push({
          type,
          trusted: event.isTrusted,
          target: normalize(event.target?.getAttribute?.("aria-label") || event.target?.innerText || event.target?.textContent || event.target?.tagName),
        });
      }, { capture: true, once: true });
    }
    return true;
  });
}

async function readFrameEventProbe(page) {
  try {
    return await page.evaluate(() => document.querySelector("#mainIframeView")?.contentWindow?.__opencliTrustedEventProbe || []);
  } catch {
    return [];
  }
}

async function confirmAxSemantic(page, name, role = "") {
  if (typeof page.snapshot !== "function" || !name) return { available: false, matched: false, ref: "" };
  try {
    const snapshot = String(await page.snapshot({ source: "ax", viewportExpand: 2000 }) || "");
    const wanted = String(name).replace(/\s+/g, " ").trim();
    const rolePattern = role ? new RegExp(`\\b${String(role).replace(/[^a-z0-9_-]/gi, "")}\\b`, "i") : null;
    const line = snapshot.split(/\r?\n/).find((item) => {
      const normalized = item.replace(/\s+/g, " ");
      return normalized.includes(wanted) && (!rolePattern || rolePattern.test(normalized));
    });
    const ref = line?.match(/\[(\d+)\]/)?.[1] || "";
    return { available: true, matched: Boolean(line), ref };
  } catch {
    return { available: false, matched: false, ref: "" };
  }
}

/** 查找 → 滚动 → 稳定 → CDP 真实点击;元素未找到返回 null */
export async function frameClick(page, find, values = {}, opts = {}) {
  const { retries = 2, waitMs = 350, semanticName = "", semanticRole = "" } = opts;
  const ax = await confirmAxSemantic(page, semanticName, semanticRole);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const point = await framePoint(page, find, values, { waitMs: attempt === 0 ? 0 : waitMs });
    if (!point) break;
    if (point.visible && !point.occluded && point.x >= 0 && point.y >= 0) {
      await armFrameEventProbe(page);
      await cdpClick(page, point.x, point.y);
      await page.wait({ time: 0.1 });
      const events = await readFrameEventProbe(page);
      return { ...point, ax, events };
    }
  }
  if (ax.ref && typeof page.click === "function") {
    try {
      const result = await page.click(ax.ref);
      return { axFallback: true, ax, result };
    } catch {
      // Preserve the DOM/CDP failure signal for the caller.
    }
  }
  return null;
}

/** 按按钮/可点击元素文本查找并 CDP 真实点击;未找到返回 null */
export async function clickByText(page, text, values = {}, opts = {}) {
  const { exact = true, disabledOk = false, skipChecked = false, waitMs = 350 } = opts;
  return frameClick(page, (doc, win, vals) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const wanted = normalize(String(vals.text));
    const nodes = Array.from(doc.querySelectorAll(
      'button, [role="button"], a, label, .el-radio, .el-checkbox, .el-switch, .el-radio-button, .el-checkbox__label, .el-radio__label',
    ));
    const match = (node) => {
      const textValue = normalize(node.innerText || node.textContent);
      return vals.exact ? textValue === wanted : textValue.includes(wanted);
    };
    const candidates = nodes.filter(match);
    if (vals.skipChecked) {
      const input = candidates[0]?.querySelector('input[type="radio"], input[type="checkbox"]')
        || (() => {
          const label = candidates[0]?.closest("label");
          return label?.querySelector('input[type="radio"], input[type="checkbox"]') || null;
        })();
      if (input?.checked) return null;
    }
    if (!vals.disabledOk) {
      const enabled = candidates.find((node) => {
        if (node.disabled || node.getAttribute("aria-disabled") === "true") return false;
        return !node.closest(".is-disabled, [aria-disabled='true'], .el-radio.is-disabled, .el-checkbox.is-disabled");
      });
      if (enabled) return enabled;
    }
    return candidates[0] || null;
  }, { text, exact, disabledOk, skipChecked, ...values }, {
    waitMs,
    semanticName: text,
    semanticRole: opts.semanticRole || "",
  });
}

/**
 * 宽视口 CDP 点击:先用 Emulation.setDeviceMetricsOverride 把顶层视口扩到
 * wideWidth,使 iframe 内元素完整落入视口(修复 AGC 页面 elementFromPoint
 * 返回 null 的遮挡误判),定位后真实点击,最后恢复原始视口。
 * 返回点击点信息;元素未找到返回 null。
 */
export async function frameClickWide(page, find, values = {}, opts = {}) {
  const wideWidth = opts.wideWidth || 1600;
  const wideHeight = opts.wideHeight || 1000;
  let overridden = false;
  try {
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width: wideWidth,
      height: wideHeight,
      deviceScaleFactor: 1,
    });
    overridden = true;
    await page.wait({ time: 0.4 });
    return await frameClick(page, find, values, opts);
  } finally {
    if (overridden) {
      await page.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await page.wait({ time: 0.3 });
    }
  }
}

/** 宽视口版 clickByText:按文本查找并真实点击,修复视口外遮挡误判。 */
export async function clickByTextWide(page, text, values = {}, opts = {}) {
  const { exact = true, disabledOk = false, skipChecked = false, waitMs = 350, ...rest } = opts;
  const find = (doc, win, vals) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const wanted = normalize(String(vals.text));
    const nodes = Array.from(doc.querySelectorAll(
      'button, [role="button"], a, label, .el-radio, .el-checkbox, .el-switch, .el-radio-button, .el-checkbox__label, .el-radio__label',
    ));
    const match = (node) => {
      const textValue = normalize(node.innerText || node.textContent);
      return vals.exact ? textValue === wanted : textValue.includes(wanted);
    };
    const candidates = nodes.filter(match);
    if (vals.skipChecked) {
      const input = candidates[0]?.querySelector('input[type="radio"], input[type="checkbox"]')
        || (() => {
          const label = candidates[0]?.closest("label");
          return label?.querySelector('input[type="radio"], input[type="checkbox"]') || null;
        })();
      if (input?.checked) return null;
    }
    if (!vals.disabledOk) {
      const enabled = candidates.find((node) => {
        if (node.disabled || node.getAttribute("aria-disabled") === "true") return false;
        return !node.closest(".is-disabled, [aria-disabled='true'], .el-radio.is-disabled, .el-checkbox.is-disabled");
      });
      if (enabled) return enabled;
    }
    return candidates[0] || null;
  };
  return frameClickWide(page, find, { text, exact, disabledOk, skipChecked, ...values }, {
    waitMs,
    semanticName: text,
    semanticRole: opts.semanticRole || "",
    ...rest,
  });
}
