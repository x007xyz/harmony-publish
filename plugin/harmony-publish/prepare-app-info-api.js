import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";
import { SITE, projectConfig } from "./shared.js";
import {
  buildAppInfoBody,
  defaultIconPath,
  officialContext,
  queryOfficialAppInfo,
  updateOfficialAppInfo,
  updateOfficialFileInfo,
  updateOfficialLanguages,
  uploadOfficialAsset,
} from "./publishing-api-common.js";

function resolveCategoryIds(cfg) {
  try {
    const dict = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "references", "category-ids.json"), "utf8")
    );
    const catId = cfg.category ? dict.level2.byZh[cfg.category] : undefined;
    const tagId = cfg.tag ? dict.tags.byZh[cfg.tag] : undefined;
    if (!catId || !tagId) return null;
    return { harmonyChildType: Number(catId), kindMainTag: Number(tagId) };
  } catch {
    return null;
  }
}

cli({
  site: SITE,
  name: "prepare-app-info",
  description: "Update application metadata, localized copy, and icon through official Publishing and Upload APIs",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "metadata", default: "", help: "AppGallery metadata JSON" },
    { name: "icon", default: "", help: "App icon PNG; defaults to AppScope app_icon.png" },
    { name: "device-types", default: "4,5", help: "Comma-separated device types to link the icon to (4=phone, 5=tablet)" },
    { name: "credential", default: "", help: "Service Account private.json" },
  ],
  columns: ["status", "backend", "appId", "languages", "icon", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg);
    const currentPayload = await queryOfficialAppInfo(context.credential, context.appId);
    const body = buildAppInfoBody(cfg, context.metadata, currentPayload.appInfo || {});
    let resolvedFromDict = null;
    if (!body.harmonyChildType || !body.kindMainTag) {
      resolvedFromDict = resolveCategoryIds(cfg);
      if (resolvedFromDict) {
        body.harmonyChildType = body.harmonyChildType || resolvedFromDict.harmonyChildType;
        body.kindMainTag = body.kindMainTag || resolvedFromDict.kindMainTag;
      }
    }
    if (!body.harmonyChildType) {
      throw new ArgumentError(
        "Missing numeric harmonyChildType. Resolve it from references/category-ids.json and add it to projects.json."
      );
    }
    if (!body.kindMainTag) {
      throw new ArgumentError(
        "Missing numeric kindMainTag. Resolve it from references/category-ids.json and add it to projects.json."
      );
    }
    await updateOfficialAppInfo(context.credential, context.appId, body);
    const languages = await updateOfficialLanguages(context.credential, context.appId, context.metadata);
    const icon = String(args.icon || defaultIconPath(cfg));
    if (!existsSync(icon)) throw new ArgumentError(`App icon not found: ${icon}`);
    const uploaded = await uploadOfficialAsset(context.credential, context.appId, icon);
    const iconDeviceTypes = String(args["device-types"] || "4,5")
      .split(",").map((value) => Number(value.trim())).filter(Boolean);
    await updateOfficialFileInfo(context.credential, context.appId, {
      appIconList: [{
        lang: String(context.metadata.defaultLanguage || "zh-CN"),
        fileInfoList: iconDeviceTypes.map((deviceType) => ({
          deviceType,
          objectIdList: [uploaded.objectId],
          showType: 0,
        })),
      }],
    });
    return [{
      status: "updated",
      backend: "official-connect-api",
      appId: context.appId,
      languages: languages.join(","),
      icon: uploaded.path,
      detail: `category=${body.harmonyChildType}; tag=${body.kindMainTag}; iconBytes=${uploaded.bytes}` +
        (resolvedFromDict ? " (ids resolved from official dictionary)" : ""),
    }];
  },
});
