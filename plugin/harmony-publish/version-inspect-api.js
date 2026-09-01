import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, projectConfig } from "./shared.js";
import { officialContext, queryOfficialAppInfo } from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "version-inspect",
  description: "Inspect version, review, release-time, package, and language state through the official Publishing API",
  access: "read",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "credential", default: "", help: "Service Account private.json" },
  ],
  columns: ["status", "backend", "appId", "versionName", "versionCode", "buildVersion", "reviewState", "releaseTime", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    const payload = await queryOfficialAppInfo(context.credential, context.appId);
    const info = payload.appInfo || {};
    return [{
      status: "ready",
      backend: "official-connect-api",
      appId: context.appId,
      versionName: info.versionNumber || "",
      versionCode: info.versionCode ?? "",
      buildVersion: info.buildVersion || "",
      reviewState: info.reviewState ?? "unknown",
      releaseTime: info.releaseTime || "",
      detail: `versionId=${info.versionId || ""}; onShelfVersion=${info.onShelfVersionNumber || ""}; languages=${(payload.languages || []).length}`,
    }];
  },
});
