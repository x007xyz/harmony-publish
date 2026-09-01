import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";
import { connectRequest } from "./agc-api.js";
import { SITE, bool, projectConfig } from "./shared.js";
import { assertConnectSuccess, officialContext } from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "release-time",
  description: "Update an already submitted version's release time through the official Publishing API",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "mode", default: "immediate", choices: ["immediate", "scheduled"], help: "Release immediately after approval or at a scheduled time" },
    { name: "release-time", default: "", help: "UTC offset format yyyy-MM-ddTHH:mm:ss+0800 for scheduled mode" },
    { name: "credential", default: "", help: "Service Account private.json" },
    { name: "confirm", type: "boolean", default: false, help: "Required because this changes submitted release timing" },
  ],
  columns: ["status", "backend", "appId", "mode", "releaseTime", "detail"],
  func: async (args) => {
    if (!bool(args.confirm, false)) throw new ArgumentError("Changing release time requires --confirm true");
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    const mode = String(args.mode || "immediate");
    const requestedReleaseTime = String(args["release-time"] || "").trim();
    const releaseTime = requestedReleaseTime || new Date().toISOString().replace(/\.\d{3}Z$/, "+0000");
    if (mode === "scheduled" && !requestedReleaseTime) throw new ArgumentError("--release-time is required for scheduled mode");
    const query = new URLSearchParams({ appId: context.appId });
    assertConnectSuccess(
      await connectRequest(context.credential, `/publish/v2/on-shelf-time?${query}`, {
        method: "PUT",
        body: { changeType: mode === "immediate" ? 2 : 3, releaseTime, releaseType: 1 },
      }),
      "Update release time",
    );
    return [{ status: "updated", backend: "official-connect-api", appId: context.appId, mode, releaseTime, detail: "releaseType=1" }];
  },
});
