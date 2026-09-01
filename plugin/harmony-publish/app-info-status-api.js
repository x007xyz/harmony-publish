import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, projectConfig } from "./shared.js";
import { officialContext, queryOfficialAppInfo } from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "app-info-status",
  description: "Query application metadata and localized information through the official Publishing API",
  access: "read",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "credential", default: "", help: "Service Account private.json" },
    { name: "lang", default: "", help: "Optional language filter" },
  ],
  columns: ["status", "backend", "appId", "reviewState", "releaseTime", "version", "languages", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    const payload = await queryOfficialAppInfo(context.credential, context.appId, String(args.lang || ""));
    const info = payload.appInfo || {};
    const languages = payload.languages || [];
    return [{
      status: "ready",
      backend: "official-connect-api",
      appId: context.appId,
      reviewState: info.reviewState ?? "unknown",
      releaseTime: info.releaseTime || "",
      version: info.versionNumber ? `${info.versionNumber} (${info.versionCode ?? "?"})` : "",
      languages: languages.map((item) => item.lang || item.language).filter(Boolean).join(","),
      detail: JSON.stringify({
        harmonyChildType: info.harmonyChildType,
        kindMainTag: info.kindMainTag,
        kindSubTags: info.kindSubTags,
        publishCountry: info.publishCountry,
        deviceTypes: info.deviceTypes,
        privacyAgreementId: info.privacyAgreementId,
        auditInfo: payload.auditInfo ?? null,
      }),
    }];
  },
});
