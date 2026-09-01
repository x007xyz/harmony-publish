import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, checkReleaseSigning, findLatestApp, findLatestHap, inspectApp, inspectHap, loadMetadata, metadataPath, pngDimensions, projectConfig, projectPath, readAppInfo, readSigningInfo } from "./shared.js";

cli({
  site: SITE,
  name: "preflight",
  description: "Check project build, release signing, HAP, and AppGallery listing prerequisites",
  access: "read",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "metadata", default: "", help: "AppGallery metadata JSON (defaults to <project>/release/appgallery.metadata.json)" },
    { name: "hap", default: "", help: "Signed HAP; defaults to newest build output" },
  ],
  columns: ["check", "status", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const project = projectPath(args.project);
    const info = readAppInfo(project);
    const signing = readSigningInfo(project);
    const releaseSigning = checkReleaseSigning(signing);
    const rows = [];
    const add = (check, ok, detail, warning = false) => rows.push({
      check,
      status: ok ? "pass" : warning ? "warning" : "block",
      detail,
    });

    add("bundle_name", Boolean(info.bundleName), info.bundleName);
    add("app_name", Boolean(info.appName) && info.appName.length <= 64, info.appName || "missing");
    add("version", Number.isInteger(info.versionCode) && info.versionCode > 0, `${info.versionName} (${info.versionCode})`);
    add("vendor", info.vendor !== "example", info.vendor === "example" ? "vendor is still the template value: example" : info.vendor, true);

    const iconPath = join(project, "AppScope", "resources", "base", "media", "app_icon.png");
    const icon = pngDimensions(iconPath);
    add("app_icon", Boolean(icon) && icon.width === icon.height && icon.width >= 1024,
      icon ? `${icon.width}x${icon.height} ${iconPath}` : `missing or invalid PNG: ${iconPath}`);

    add("release_signing_files", releaseSigning.missing.length === 0,
      releaseSigning.missing.length ? `${releaseSigning.missing.length} signing file(s) missing` : "certificate, provision profile, and keystore exist");
    add("release_signing_alias", !releaseSigning.debugAlias,
      releaseSigning.debugAlias ? "debugKey is configured; create/select a release certificate before publishing" : `alias=${signing.alias || "missing"}`);
    add("signing_secrets", !signing.embedsKeyPassword && !signing.embedsStorePassword,
      signing.embedsKeyPassword || signing.embedsStorePassword
        ? "password material is embedded in build-profile.json5; migrate it to DevEco secure configuration/environment before sharing or committing"
        : "no inline signing passwords detected",
      true);

    const metadataFile = resolve(String(args.metadata || metadataPath(cfg)));
    if (existsSync(metadataFile)) {
      const metadata = loadMetadata(metadataFile).data;
      const privacyHosted = metadata.privacyPolicyUrl === "AGC_PRIVACY_HOSTING";
      add("privacy_url", privacyHosted || (/^https:\/\//.test(metadata.privacyPolicyUrl || "") && !/TODO/i.test(metadata.privacyPolicyUrl || "")),
        privacyHosted ? "AppGallery Connect privacy hosting" : metadata.privacyPolicyUrl || "missing");
      add("release_notes", Boolean(metadata.releaseNotes?.["zh-CN"]), metadata.releaseNotes?.["zh-CN"] || "missing");
      add("store_description", Boolean(metadata.description?.["zh-CN"]), metadata.description?.["zh-CN"] || "missing");
      const screenshots = Array.isArray(metadata.screenshots) ? metadata.screenshots : [];
      add("screenshots", screenshots.length > 0 && screenshots.every((item) => existsSync(resolve(project, item))),
        screenshots.length ? `${screenshots.length} configured` : "no store screenshots configured");
      add("copyright", Boolean(metadata.copyrightFiles?.length), metadata.copyrightFiles?.length
        ? `${metadata.copyrightFiles.length} file(s) configured`
        : "no copyright file configured; the current AGC form will determine whether this release requires one",
        true);
    } else {
      add("store_metadata", false, `missing: ${metadataFile}`);
    }

    const hapPath = String(args.hap || "").trim() || findLatestHap(project);
    if (hapPath) {
      const hap = inspectHap(hapPath);
      add("signed_hap", /-signed\.hap$/.test(hap.filename), `${hap.filename}, ${hap.bytes} bytes`);
      add("hap_release_mode", hap.app.debug === false && String(hap.app.buildMode).toLowerCase() === "release",
        `buildMode=${hap.app.buildMode}, debug=${hap.app.debug}`);
      add("hap_bundle", hap.app.bundleName === info.bundleName, hap.app.bundleName || "missing");
      add("hap_version", hap.app.versionCode === info.versionCode && hap.app.versionName === info.versionName,
        `${hap.app.versionName} (${hap.app.versionCode})`);
    } else {
      add("signed_hap", false, "no signed HAP build output found");
    }

    const appPath = findLatestApp(project);
    if (appPath) {
      const appPackage = inspectApp(appPath);
      add("signed_app", appPackage.signed, `${appPackage.filename}, ${appPackage.bytes} bytes`);
      add("app_bundle", appPackage.bundleName === info.bundleName, appPackage.bundleName || "missing");
      add("app_version", appPackage.versionCode === info.versionCode && appPackage.versionName === info.versionName,
        `${appPackage.versionName} (${appPackage.versionCode})`);
    } else {
      add("signed_app", false, "no signed APP build output found");
    }

    return rows;
  },
});
