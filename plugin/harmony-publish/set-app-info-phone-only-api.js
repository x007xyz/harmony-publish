import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, projectConfig } from "./shared.js";
import { officialContext, updateOfficialAppInfo } from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "set-app-info-phone-only",
  description: "Limit supported devices to HarmonyOS phone through the official Publishing API",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "credential", default: "", help: "Service Account private.json" },
    { name: "countries", default: "CN", help: "Comma-separated release countries required by the API" },
  ],
  columns: ["status", "backend", "appId", "deviceType", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    await updateOfficialAppInfo(context.credential, context.appId, {
      publishCountry: String(args.countries || "CN"),
      encrypted: 0,
      deviceTypes: [{ deviceType: 4, appAdapters: "" }],
    });
    return [{ status: "updated", backend: "official-connect-api", appId: context.appId, deviceType: 4, detail: "Phone only" }];
  },
});
