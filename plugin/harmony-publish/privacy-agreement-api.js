import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";
import { connectRequest } from "./agc-api.js";
import { SITE, bool, projectConfig } from "./shared.js";
import { assertConnectSuccess, officialContext } from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "privacy-agreement",
  description: "Update or submit an existing privacy-policy agreement through the official Publishing API",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "action", default: "update", choices: ["update", "submit"], help: "Official privacy agreement action" },
    { name: "body-file", default: "", help: "Full official agreement JSON body for update" },
    { name: "agreement-id", default: "", help: "Privacy agreement ID; defaults to project/metadata configuration" },
    { name: "credential", default: "", help: "Service Account private.json" },
    { name: "confirm-submit", type: "boolean", default: false, help: "Required for submit" },
  ],
  columns: ["status", "backend", "appId", "agreementId", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    const action = String(args.action || "update");
    const agreementId = String(args["agreement-id"] || context.metadata.privacyAgreementId || cfg.privacyAgreementId || "").trim();
    if (!agreementId) throw new ArgumentError("Privacy agreement must first be created in AGC; then pass --agreement-id or configure privacyAgreementId");
    let body;
    if (action === "update") {
      const bodyFile = String(args["body-file"] || "").trim();
      const path = bodyFile ? resolve(bodyFile) : "";
      if (!path || !existsSync(path) || !statSync(path).isFile()) throw new ArgumentError("--body-file is required for privacy agreement update; the full policy data must reflect the app's actual behavior");
      body = JSON.parse(readFileSync(path, "utf8"));
      body.id = agreementId;
      assertConnectSuccess(
        await connectRequest(context.credential, "/publish/v2/agreement", { method: "PUT", headers: { appId: context.appId }, body }),
        "Update privacy agreement",
      );
    } else {
      if (!bool(args["confirm-submit"], false)) throw new ArgumentError("Privacy agreement submission requires --confirm-submit true");
      body = { id: agreementId, requireConfirm: 0 };
      assertConnectSuccess(
        await connectRequest(context.credential, "/publish/v2/agreement/submit", { method: "PUT", headers: { appId: context.appId }, body }),
        "Submit privacy agreement",
      );
    }
    return [{ status: action === "submit" ? "submitted" : "updated", backend: "official-connect-api", appId: context.appId, agreementId, detail: action }];
  },
});
