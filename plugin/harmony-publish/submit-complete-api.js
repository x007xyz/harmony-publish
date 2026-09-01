import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { connectRequest, loadCredential, resolveOfficialAppId } from "./agc-api.js";
import { SITE, bool, projectConfig } from "./shared.js";

cli({
  site: SITE,
  name: "submit-complete",
  description: "Submit a completed HarmonyOS release through the official Publishing API",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "credential", default: "", help: "Developer-level Service Account private.json; may also use HUAWEI_AGC_SERVICE_ACCOUNT" },
    { name: "confirm-submit", type: "boolean", default: false, help: "Must be true to submit the release for review" },
    { name: "release-phase", default: "0", help: "0=全量发布, 3=分阶段发布" },
    { name: "remark", default: "", help: "提审发布备注(10-300字符,可空)" },
  ],
  columns: ["status", "backend", "appId", "detail"],
  func: async (args) => {
    if (!bool(args["confirm-submit"], false)) {
      throw new ArgumentError("Final submission is disabled; pass --confirm-submit true");
    }
    const cfg = projectConfig(args);
    const { credential } = loadCredential(args, cfg, true);
    const appId = await resolveOfficialAppId(credential, cfg);
    const query = new URLSearchParams({ appid: appId });
    const payload = await connectRequest(credential, `/publish/v2/app-submit?${query}`, {
      method: "POST",
      body: {
        releaseType: 1,
        releasePhase: Number(args["release-phase"] || 0),
        remark: String(args.remark || "").trim(),
      },
    });
    const code = Number(payload?.ret?.code ?? 0);
    if (code !== 0) {
      throw new CommandExecutionError(`Submit release failed: code=${code}, message=${payload?.ret?.msg || "unknown"}`);
    }
    return [{
      status: "submitted",
      backend: "official-connect-api",
      appId,
      detail: payload?.ret?.msg || "success",
    }];
  },
});
