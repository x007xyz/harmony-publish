import { join } from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, TOOLS_DIR, checkReleaseSigning, projectConfig, projectDir, projectPath, readSigningInfo, runTool } from "./shared.js";

cli({
  site: SITE,
  name: "configure-signing",
  description: "Bind a project to the shared release key/certificate and its dedicated AGC Profile",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "profile", default: "", help: "AGC release Profile (.p7b) path (defaults to <project>/release/signing/<profileFile>)" },
  ],
  columns: ["status", "product", "keyAlias", "certificate", "profile", "keystore"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const project = projectPath(args.project);
    const profile = String(args.profile || join(cfg.projectRoot, "release", "signing", cfg.profileFile));
    const target = cfg.flutter ? "ohos/build-profile.json5" : "build-profile.json5";
    runTool("node", [join(TOOLS_DIR, "configure-release-signing.mjs"), "--project", cfg.projectRoot, "--target", target, "--profile", profile], project);
    const signing = readSigningInfo(project);
    const check = checkReleaseSigning(signing);
    return [{
      status: check.ok ? "ready" : "blocked",
      product: "release",
      keyAlias: signing.alias,
      certificate: signing.certPath,
      profile: signing.provisionPath,
      keystore: signing.storePath,
    }];
  },
});
