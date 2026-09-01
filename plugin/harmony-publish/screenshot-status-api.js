import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, projectConfig } from "./shared.js";
import { officialContext, queryOfficialAppInfo } from "./publishing-api-common.js";

function countScreenshots(value, key = "") {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countScreenshots(item, key), 0);
  if (!value || typeof value !== "object") return /screen.*shot/i.test(key) && typeof value === "string" && value ? 1 : 0;
  let total = 0;
  for (const [childKey, child] of Object.entries(value)) {
    if (/screen.*shot/i.test(childKey) && Array.isArray(child)) total += child.length;
    else total += countScreenshots(child, childKey);
  }
  return total;
}

cli({
  site: SITE,
  name: "screenshot-status",
  description: "Inspect localized screenshot metadata through the official Publishing API",
  access: "read",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "credential", default: "", help: "Service Account private.json" },
  ],
  columns: ["status", "backend", "appId", "language", "count", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    const payload = await queryOfficialAppInfo(context.credential, context.appId);
    const languages = payload.languages || [];
    if (!languages.length) return [{ status: "missing", backend: "official-connect-api", appId: context.appId, language: "", count: 0, detail: "No language records" }];
    return languages.map((item) => ({
      status: countScreenshots(item) >= 3 ? "ready" : "missing",
      backend: "official-connect-api",
      appId: context.appId,
      language: item.lang || item.language || "unknown",
      count: countScreenshots(item),
      detail: "Count derived from official application-language response",
    }));
  },
});
