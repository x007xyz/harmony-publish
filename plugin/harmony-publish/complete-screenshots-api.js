import { existsSync } from "node:fs";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";
import { SITE, projectConfig } from "./shared.js";
import {
  officialContext,
  resolveAssetPath,
  updateOfficialFileInfo,
  uploadOfficialAsset,
} from "./publishing-api-common.js";

function screenshotGroups(metadata) {
  if (metadata.screenshotsByLanguage && typeof metadata.screenshotsByLanguage === "object") {
    return Object.entries(metadata.screenshotsByLanguage);
  }
  return [[String(metadata.defaultLanguage || "zh-CN"), metadata.screenshots || []]];
}

function screenshotsForDevice(metadata, deviceType) {
  // 平板(5)读 screenshotsTablet(1280x1920 竖屏);手机(4)读 screenshots(1080x1920 竖屏)
  const key = deviceType === 5 ? "screenshotsTablet" : "screenshots";
  return metadata[key] || [];
}

cli({
  site: SITE,
  name: "complete-screenshots",
  description: "Upload and associate localized screenshots through official Upload Management and Publishing APIs",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "metadata", default: "", help: "AppGallery metadata JSON" },
    { name: "credential", default: "", help: "Service Account private.json" },
    { name: "device-types", default: "4", help: "Comma-separated device types: 4=phone(1080x1920), 5=tablet(1280x1920, reads screenshotsTablet)" },
    { name: "show-type", default: "0", help: "Official screenshot orientation/display type (0=portrait)" },
  ],
  columns: ["status", "backend", "appId", "language", "count", "bytes", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg);
    const deviceTypes = String(args["device-types"] || "4")
      .split(",").map((value) => Number(value.trim())).filter(Boolean);
    const showType = Number(args["show-type"] || 0);
    const body = { screenShotList: [] };
    const rows = [];
    for (const deviceType of deviceTypes) {
      const values = screenshotsForDevice(context.metadata, deviceType);
      if (!Array.isArray(values) || values.length < 3) {
        throw new ArgumentError(`At least 3 screenshots are required for deviceType=${deviceType}`);
      }
      const uploaded = [];
      for (const value of values) {
        const path = resolveAssetPath(cfg, context.metadataPath, value);
        if (!existsSync(path)) throw new ArgumentError(`Screenshot not found: ${path}`);
        uploaded.push(await uploadOfficialAsset(context.credential, context.appId, path));
      }
      body.screenShotList.push({
        lang: String(context.metadata.defaultLanguage || "zh-CN"),
        fileInfoList: [{
          deviceType,
          objectIdList: uploaded.map((item) => item.objectId),
          showType,
        }],
      });
      rows.push({
        status: "uploaded",
        backend: "official-connect-api",
        appId: context.appId,
        language: String(context.metadata.defaultLanguage || "zh-CN"),
        count: uploaded.length,
        bytes: uploaded.reduce((sum, item) => sum + item.bytes, 0),
        detail: `deviceType=${deviceType}; showType=${showType}`,
      });
    }
    await updateOfficialFileInfo(context.credential, context.appId, body);
    return rows;
  },
});
