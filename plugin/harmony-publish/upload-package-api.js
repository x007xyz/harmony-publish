import { readFileSync } from "node:fs";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { connectRequest, loadCredential, resolveOfficialAppId } from "./agc-api.js";
import { SITE, findLatestApp, inspectApp, projectConfig, projectPath } from "./shared.js";

function assertConnectSuccess(payload, operation) {
  const code = Number(payload?.ret?.code ?? 0);
  if (code !== 0) {
    throw new CommandExecutionError(`${operation} failed: code=${code}, message=${payload?.ret?.msg || "unknown"}`);
  }
  return payload;
}

async function uploadBinary(urlInfo, data) {
  if (!urlInfo?.url || !urlInfo?.objectId) {
    throw new CommandExecutionError("Upload Management API did not return url and objectId");
  }
  const headers = Object.fromEntries(
    Object.entries(urlInfo.headers || {}).map(([key, value]) => [key, String(value)]),
  );
  const response = await fetch(urlInfo.url, {
    method: String(urlInfo.method || "PUT").toUpperCase(),
    headers,
    body: data,
  });
  if (!response.ok) throw new CommandExecutionError(`Official file upload failed: HTTP ${response.status}`);
  return urlInfo.objectId;
}

async function waitForCompile(credential, appId, packageId) {
  const query = new URLSearchParams({ appId, pkgIds: packageId });
  let last = [];
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const payload = assertConnectSuccess(
      await connectRequest(credential, `/publish/v3/package/compile/status?${query}`),
      "Query package compile status",
    );
    last = payload.pkgStateList || [];
    if (last.some((item) => String(item?.pkgId || "") === packageId && Number(item?.successStatus) === 0)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new CommandExecutionError(`Package parsing did not complete in time: ${JSON.stringify(last)}`);
}

cli({
  site: SITE,
  name: "upload-package",
  description: "Upload and associate a signed APP through official Upload Management and Publishing APIs",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "app", default: "", help: "Signed APP file; defaults to the newest signed build" },
    { name: "credential", default: "", help: "Developer-level Service Account private.json; may also use HUAWEI_AGC_SERVICE_ACCOUNT" },
  ],
  columns: ["status", "backend", "artifact", "version", "packageId", "sha256", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const project = projectPath(args.project);
    const artifact = inspectApp(String(args.app || "").trim() || findLatestApp(project));
    if (!artifact.signed) throw new CommandExecutionError("Refusing to upload an unsigned APP package");
    if (artifact.bundleName !== cfg.bundleName) {
      throw new CommandExecutionError(`Bundle mismatch: expected ${cfg.bundleName}, got ${artifact.bundleName}`);
    }
    const { credential } = loadCredential(args, cfg, true);
    const appId = await resolveOfficialAppId(credential, cfg);
    const data = readFileSync(artifact.path);
    const uploadQuery = new URLSearchParams({
      appId,
      fileName: artifact.filename,
      sha256: artifact.sha256,
      contentLength: String(data.length),
      chineseMainlandFlag: "1",
    });
    const uploadTicket = assertConnectSuccess(
      await connectRequest(credential, `/publish/v2/upload-url/for-obs?${uploadQuery}`),
      "Get official upload URL",
    );
    const objectId = await uploadBinary(uploadTicket.urlInfo, data);
    const packageQuery = new URLSearchParams({ appId, releaseType: "1", releasePhase: "0" });
    const packageResult = assertConnectSuccess(
      await connectRequest(credential, `/publish/v3/app-package-info?${packageQuery}`, {
        method: "PUT",
        body: { fileName: artifact.filename, objectId },
      }),
      "Associate uploaded APP",
    );
    const packageId = String(packageResult.packageId || "");
    if (!packageId) throw new CommandExecutionError("Publishing API did not return packageId");
    await waitForCompile(credential, appId, packageId);
    return [{
      status: "uploaded",
      backend: "official-connect-api",
      artifact: artifact.filename,
      version: `${artifact.versionName} (${artifact.versionCode})`,
      packageId,
      sha256: artifact.sha256,
      detail: "Upload, package association, and compile verification succeeded",
    }];
  },
});
