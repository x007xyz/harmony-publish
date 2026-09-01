import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, findLatestApp, inspectApp, projectPath, verifySignedPackage } from "./shared.js";

cli({
  site: SITE,
  name: "artifact",
  description: "Inspect and cryptographically verify the newest signed APP package",
  access: "read",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "app", default: "", help: "Signed APP package; defaults to newest build output" },
  ],
  columns: ["artifact", "bundleName", "versionName", "versionCode", "buildMode", "debug", "bytes", "sha256"],
  func: async (args) => {
    const project = projectPath(args.project);
    const app = inspectApp(String(args.app || "").trim() || findLatestApp(project));
    verifySignedPackage(app.path, project);
    return [{
      artifact: app.path,
      bundleName: app.bundleName,
      versionName: app.versionName,
      versionCode: app.versionCode,
      buildMode: "release",
      debug: false,
      bytes: app.bytes,
      sha256: app.sha256,
    }];
  },
});
