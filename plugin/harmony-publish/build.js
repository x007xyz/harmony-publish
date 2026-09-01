import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, HVIGOR, OHPM, bool, checkReleaseSigning, findLatestApp, findLatestHap, inspectApp, inspectHap, projectPath, readAppInfo, readSigningInfo, runTool, verifySignedPackage } from "./shared.js";

cli({
  site: SITE,
  name: "build",
  description: "Install dependencies and create verified release-signed project APP and HAP packages",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "install", type: "boolean", default: true, help: "Run ohpm install first" },
  ],
  columns: ["status", "artifact", "version", "bytes", "sha256"],
  func: async (args) => {
    const project = projectPath(args.project);
    const info = readAppInfo(project);
    const signing = readSigningInfo(project);
    const releaseSigning = checkReleaseSigning(signing);
    if (!releaseSigning.ok) {
      throw new CommandExecutionError(releaseSigning.debugAlias
        ? "Release build blocked: build-profile.json5 still uses debugKey"
        : `Release build blocked: ${releaseSigning.missing.length} signing file(s) are missing`);
    }

    if (bool(args.install, true)) runTool(OHPM, ["install"], project);
    runTool(HVIGOR, [
      "--no-daemon",
      "--mode", "project",
      "-p", "product=release",
      "-p", "buildMode=release",
      "assembleApp",
      "--no-incremental",
    ], project);

    const hap = inspectHap(findLatestHap(project));
    if (hap.app.debug !== false || String(hap.app.buildMode).toLowerCase() !== "release") {
      throw new CommandExecutionError(`Hvigor output is not a release HAP: buildMode=${hap.app.buildMode}, debug=${hap.app.debug}`);
    }
    if (hap.app.bundleName !== info.bundleName || hap.app.versionCode !== info.versionCode) {
      throw new CommandExecutionError("HAP metadata does not match AppScope/app.json5");
    }
    const artifact = inspectApp(findLatestApp(project));
    if (!artifact.signed) throw new CommandExecutionError("Hvigor did not create a signed APP package");
    if (artifact.bundleName !== info.bundleName || artifact.versionCode !== info.versionCode) {
      throw new CommandExecutionError("APP package metadata does not match AppScope/app.json5");
    }
    verifySignedPackage(artifact.path, project);
    return [{
      status: "ready",
      artifact: artifact.path,
      version: `${artifact.versionName} (${artifact.versionCode})`,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    }];
  },
});
