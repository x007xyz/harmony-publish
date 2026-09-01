import { constants, createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, bool, projectConfig } from "./shared.js";

const CONNECT_API = "https://connect-api.cloud.huawei.com/api";
const SERVICE_ACCOUNT_AUDIENCE = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createServiceAccountJwt(credential, nowSeconds = Math.floor(Date.now() / 1000)) {
  const keyId = String(credential?.key_id || "").trim();
  const issuer = String(credential?.sub_account || "").trim();
  const privateKey = String(credential?.private_key || "");
  if (!keyId || !issuer || !privateKey) {
    throw new ArgumentError("Service Account credential requires key_id, sub_account, and private_key");
  }
  const header = base64url(JSON.stringify({ kid: keyId, typ: "JWT", alg: "PS256" }));
  const payload = base64url(JSON.stringify({
    aud: SERVICE_ACCOUNT_AUDIENCE,
    iss: issuer,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

function credentialPath(args, cfg) {
  const candidate = String(
    args.credential
    || process.env.HUAWEI_AGC_SERVICE_ACCOUNT
    || process.env.AGC_SERVICE_ACCOUNT
    || cfg.serviceAccountFile
    || "",
  ).trim();
  return candidate ? resolve(candidate) : "";
}

export function loadCredential(args, cfg, required = true) {
  const path = credentialPath(args, cfg);
  if (!path || !existsSync(path)) {
    if (!required) return { path, credential: null };
    throw new CommandExecutionError(
      "AGC Service Account credential not found. Pass --credential <private.json> or set HUAWEI_AGC_SERVICE_ACCOUNT. "
      + "Create a developer-level Service Account in AGC > 用户与访问 > API密钥 > Connect API.",
    );
  }
  let credential;
  try {
    credential = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CommandExecutionError(`Cannot read AGC Service Account credential: ${error?.message || error}`);
  }
  createServiceAccountJwt(credential, 1_700_000_000);
  return { path, credential };
}

function assertSuccess(payload, operation) {
  const code = Number(payload?.ret?.code ?? 0);
  if (code !== 0) {
    throw new CommandExecutionError(`${operation} failed: code=${code}, message=${payload?.ret?.msg || "unknown"}`);
  }
  return payload;
}

export async function connectRequest(credential, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${CONNECT_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${createServiceAccountJwt(credential)}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new CommandExecutionError(`AGC Connect API returned non-JSON data: HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new CommandExecutionError(
      `AGC Connect API failed: HTTP ${response.status}, code=${payload?.ret?.code ?? "unknown"}, message=${payload?.ret?.msg || "unknown"}`,
    );
  }
  return payload;
}

export async function resolveOfficialAppId(credential, cfg) {
  if (cfg.appId) return String(cfg.appId);
  const query = new URLSearchParams({ packageName: cfg.bundleName, packageTypes: "7" });
  const payload = assertSuccess(
    await connectRequest(credential, `/publish/v2/appid-list?${query}`),
    "Query APP ID",
  );
  const values = (payload.appids || []).map((item) => String(item?.value || "")).filter(Boolean);
  if (values.length !== 1) {
    throw new CommandExecutionError(`Expected one APP ID for ${cfg.bundleName}, found ${values.length}`);
  }
  return values[0];
}

async function listReleaseCertificates(credential) {
  const payload = assertSuccess(
    await connectRequest(credential, "/publish/v3/cert/list", { method: "POST", body: { certType: 2 } }),
    "Query release certificates",
  );
  return payload.certList || payload.certInfo || [];
}

async function chooseReleaseCertificate(credential, requestedName) {
  const certificates = await listReleaseCertificates(credential);
  const usable = certificates.filter((item) => Number(item?.certType) === 2 || item?.certType == null);
  const wanted = String(requestedName || "release").trim().toLowerCase();
  const exact = usable.find((item) => String(item?.certName || "").trim().toLowerCase() === wanted);
  const certificate = exact || (usable.length === 1 ? usable[0] : null);
  if (!certificate?.id) {
    throw new CommandExecutionError(
      `Release certificate is ambiguous or unavailable; requested=${requestedName || "release"}, candidates=${usable.map((item) => item.certName).join(", ")}`,
    );
  }
  return certificate;
}

async function listProfiles(credential, appId) {
  const query = new URLSearchParams({ fromRecCount: "1", maxReqCount: "100" });
  const payload = assertSuccess(
    await connectRequest(credential, `/publish/v3/provision/list?${query}`, { headers: { appId } }),
    "Query Profiles",
  );
  return payload.provisionList || [];
}

async function ensureReleaseProfile(credential, cfg, appId, certificateName, restrictedAcl) {
  let profiles = await listProfiles(credential, appId);
  let profile = profiles.find((item) =>
    String(item?.provisionName || "") === cfg.profileName
    && Number(item?.provisionType) === 2
    && String(item?.appId || appId) === appId
  );
  if (profile) return { profile, created: false };
  if (restrictedAcl) {
    throw new CommandExecutionError(
      "Official API mode does not guess restricted ACL names. Add an explicit ACL list before creating this Profile.",
    );
  }
  const certificate = await chooseReleaseCertificate(credential, certificateName);
  const payload = assertSuccess(
    await connectRequest(credential, "/publish/v3/provision", {
      method: "POST",
      body: {
        provisionName: cfg.profileName,
        provisionType: 2,
        certId: String(certificate.id),
        appId,
      },
    }),
    "Create release Profile",
  );
  profile = payload.provisionInfo;
  if (!profile?.id) {
    profiles = await listProfiles(credential, appId);
    profile = profiles.find((item) => String(item?.provisionName || "") === cfg.profileName && Number(item?.provisionType) === 2);
  }
  if (!profile?.id) throw new CommandExecutionError("Release Profile was created but could not be verified");
  return { profile, created: true, certificate };
}

async function downloadProfile(profile, outputPath) {
  const url = String(profile?.provisionDownloadUrl || "");
  if (!url) throw new CommandExecutionError("Official Profile response did not include provisionDownloadUrl");
  const response = await fetch(url);
  if (!response.ok) throw new CommandExecutionError(`Profile download failed: HTTP ${response.status}`);
  const payload = Buffer.from(await response.arrayBuffer());
  const pkcs7 = payload.length > 2 && payload[0] === 0x30;
  if (!pkcs7) throw new CommandExecutionError(`Downloaded Profile is not a PKCS#7 payload: bytes=${payload.length}`);
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, payload, { mode: 0o600 });
  return { output, bytes: payload.length };
}

cli({
  site: SITE,
  name: "agc-api",
  description: "Use official AppGallery Connect Publishing/Provisioning APIs without browser automation",
  access: "write",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "action", default: "status", choices: ["status", "resolve-app-id", "list-certificates", "ensure-profile", "download-profile"], help: "Official Connect API action" },
    { name: "credential", default: "", help: "Developer-level Service Account private.json; may also use HUAWEI_AGC_SERVICE_ACCOUNT" },
    { name: "certificate-name", default: "release", help: "Release certificate name; defaults to release" },
    { name: "restricted-acl", type: "boolean", default: false, help: "Refuse implicit ACL creation; ACL names must be explicitly implemented" },
    { name: "output", default: "", help: "Downloaded Profile output path" },
  ],
  columns: ["status", "backend", "action", "appId", "resource", "output", "bytes", "detail"],
  func: async (args) => {
    const cfg = projectConfig(args);
    const action = String(args.action || "status");
    const loaded = loadCredential(args, cfg, action !== "status");
    if (action === "status") {
      const mode = loaded.path && existsSync(loaded.path) ? statSync(loaded.path).mode & 0o777 : null;
      return [{
        status: loaded.credential ? "ready" : "blocked",
        backend: "official-connect-api",
        action,
        detail: loaded.credential ? `Service Account available; mode=${mode?.toString(8)}` : "Service Account credential not configured",
      }];
    }
    const appId = await resolveOfficialAppId(loaded.credential, cfg);
    if (action === "resolve-app-id") {
      return [{ status: "ready", backend: "official-connect-api", action, appId, resource: cfg.bundleName }];
    }
    if (action === "list-certificates") {
      const certificates = await listReleaseCertificates(loaded.credential);
      return certificates.map((item) => ({
        status: "ready",
        backend: "official-connect-api",
        action,
        appId,
        resource: item.certName,
        detail: `id=${item.id}; type=${item.certType}; expires=${item.expireTime || "unknown"}`,
      }));
    }
    const ensured = await ensureReleaseProfile(
      loaded.credential,
      cfg,
      appId,
      args["certificate-name"],
      bool(args["restricted-acl"], false),
    );
    if (action === "ensure-profile") {
      return [{
        status: "ready",
        backend: "official-connect-api",
        action,
        appId,
        resource: ensured.profile.provisionName,
        detail: `id=${ensured.profile.id}; created=${ensured.created}`,
      }];
    }
    const output = String(args.output || join(cfg.projectRoot, "release", "signing", cfg.profileFile));
    const downloaded = await downloadProfile(ensured.profile, output);
    return [{
      status: "ready",
      backend: "official-connect-api",
      action,
      appId,
      resource: ensured.profile.provisionName,
      output: downloaded.output,
      bytes: downloaded.bytes,
      detail: `id=${ensured.profile.id}; created=${ensured.created}`,
    }];
  },
});
