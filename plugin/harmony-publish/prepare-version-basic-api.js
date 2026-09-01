import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, projectConfig } from "./shared.js";
import {
  buildAppInfoBody,
  officialContext,
  queryOfficialAppInfo,
  updateOfficialAppInfo,
  updateOfficialLanguages,
} from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "prepare-version-basic",
  description: "Update release countries, reviewer metadata, and localized version copy through the official Publishing API",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "metadata", default: "", help: "AppGallery metadata JSON" },
    { name: "credential", default: "", help: "Service Account private.json" },
  ],
  columns: ["status", "backend", "appId", "countries", "languages", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg);
    const current = await queryOfficialAppInfo(context.credential, context.appId);
    const body = buildAppInfoBody(cfg, context.metadata, current.appInfo || {});
    await updateOfficialAppInfo(context.credential, context.appId, body);
    const languages = await updateOfficialLanguages(context.credential, context.appId, context.metadata);
    return [{
      status: "updated",
      backend: "official-connect-api",
      appId: context.appId,
      countries: body.publishCountry,
      languages: languages.join(","),
      detail: "Application and localized version metadata updated",
    }];
  },
});
