import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";
import { connectRequest } from "./agc-api.js";
import { SITE, projectConfig } from "./shared.js";
import { assertConnectSuccess, officialContext } from "./publishing-api-common.js";

cli({
  site: SITE,
  name: "user-agreement",
  description: "Create or update a user agreement through the official Publishing API",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "action", default: "create", choices: ["create", "update"], help: "Official user-agreement action" },
    { name: "body-file", default: "", help: "Official user-agreement JSON body" },
    { name: "credential", default: "", help: "Service Account private.json" },
  ],
  columns: ["status", "backend", "appId", "agreementId", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const context = await officialContext(args, cfg, { metadataRequired: false });
    const bodyFile = String(args["body-file"] || "").trim();
    const path = bodyFile ? resolve(bodyFile) : "";
    if (!path || !existsSync(path) || !statSync(path).isFile()) throw new ArgumentError("--body-file is required and must contain truthful user-agreement data");
    const body = JSON.parse(readFileSync(path, "utf8"));
    const action = String(args.action || "create");
    if (action === "create") body.type = 2;
    const payload = assertConnectSuccess(
      await connectRequest(context.credential, "/publish/v2/agreement", {
        method: action === "create" ? "POST" : "PUT",
        headers: { appId: context.appId },
        body,
      }),
      `${action} user agreement`,
    );
    return [{ status: action === "create" ? "created" : "updated", backend: "official-connect-api", appId: context.appId, agreementId: payload.id || body.id || "", detail: action }];
  },
});
