import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { connectRequest, loadCredential, resolveOfficialAppId } from "./agc-api.js";
import { metadataPath, projectDir } from "./shared.js";

export function assertConnectSuccess(payload, operation) {
  const code = Number(payload?.ret?.code ?? 0);
  if (code !== 0) {
    throw new CommandExecutionError(`${operation} failed: code=${code}, message=${payload?.ret?.msg || "unknown"}`);
  }
  return payload;
}

function loadPublishContext(args, cfg, { metadataRequired = true } = {}) {
  const loaded = loadCredential(args, cfg, true);
  const path = resolve(String(args.metadata || metadataPath(cfg)));
  if (!existsSync(path)) {
    if (!metadataRequired) return { ...loaded, metadataPath: path, metadata: {} };
    throw new ArgumentError(`AppGallery metadata not found: ${path}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ArgumentError(`Cannot parse AppGallery metadata ${path}: ${error?.message || error}`);
  }
  return { ...loaded, metadataPath: path, metadata };
}

export function resolveAssetPath(cfg, metadataFile, value) {
  const path = String(value || "").trim();
  if (!path) throw new ArgumentError("Asset path is empty");
  if (isAbsolute(path)) return path;
  const projectRelative = resolve(cfg.projectRoot, path);
  if (existsSync(projectRelative)) return projectRelative;
  return resolve(dirname(metadataFile), path);
}

export function localized(metadata, field, lang) {
  const value = metadata?.[field];
  if (value && typeof value === "object" && !Array.isArray(value)) return String(value[lang] || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

function metadataLanguages(metadata) {
  const found = new Set([String(metadata.defaultLanguage || "zh-CN")]);
  for (const field of ["appName", "shortDescription", "description", "releaseNotes"]) {
    const value = metadata?.[field];
    if (value && typeof value === "object" && !Array.isArray(value)) Object.keys(value).forEach((lang) => found.add(lang));
  }
  return [...found].filter(Boolean);
}

export async function queryOfficialAppInfo(credential, appId, lang = "") {
  const query = new URLSearchParams({ appId, releaseType: "1" });
  if (lang) query.set("lang", lang);
  return assertConnectSuccess(
    await connectRequest(credential, `/publish/v3/app-info?${query}`),
    "Query application information",
  );
}

export function buildAppInfoBody(cfg, metadata, current = {}) {
  const body = {
    defaultLang: String(metadata.defaultLanguage || "zh-CN"),
    publishCountry: (metadata.releaseCountries || ["CN"]).join(","),
    encrypted: Number(metadata.encrypted ?? 0),
    appNetType: Number(metadata.appNetType ?? 1),
    registeredDclType: Number(metadata.registeredDclType ?? 2),
    isAiGenerate: Number(metadata.isAiGenerate ?? 0),
    deviceTypes: metadata.deviceTypes || [{ deviceType: 4, appAdapters: "" }],
  };
  if (metadata.appTariffType !== undefined) body.appTariffType = String(metadata.appTariffType);
  const scalar = {
    harmonyChildType: metadata.harmonyChildType ?? cfg.harmonyChildType ?? current.harmonyChildType,
    kindMainTag: metadata.kindMainTag ?? cfg.kindMainTag ?? current.kindMainTag,
    kindSubTags: metadata.kindSubTags ?? cfg.kindSubTags ?? current.kindSubTags,
    privacyAgreementId: metadata.privacyAgreementId ?? cfg.privacyAgreementId ?? current.privacyAgreementId,
    privacyRightsUrl: metadata.privacyRightsUrl,
    developerWebsite: metadata.developerWebsite,
    appRemark: metadata.remarks || cfg.remarks,
    appReviewName: metadata.reviewContact?.name,
  };
  for (const [key, value] of Object.entries(scalar)) {
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  if (metadata.privacyPolicyUrl && metadata.privacyPolicyUrl !== "AGC_PRIVACY_HOSTING") {
    body.privacyPolicy = metadata.privacyPolicyUrl;
  }
  if (metadata.reviewContact?.phone) body.appReviewPhoneInfo = { account: metadata.reviewContact.phone };
  if (metadata.reviewContact?.email) body.appReviewEmailInfo = { account: metadata.reviewContact.email };
  if (metadata.contact) body.customInfo = metadata.contact;
  if (body.isAiGenerate === 1) body.aiTypes = metadata.aiTypes || [];
  return body;
}

export async function updateOfficialAppInfo(credential, appId, body) {
  const query = new URLSearchParams({ appId, releaseType: "1", releasePhase: "0" });
  return assertConnectSuccess(
    await connectRequest(credential, `/publish/v3/app-info?${query}`, { method: "PUT", body }),
    "Update application information",
  );
}

export async function updateOfficialLanguages(credential, appId, metadata) {
  const results = [];
  for (const lang of metadataLanguages(metadata)) {
    const body = {
      lang,
      appName: localized(metadata, "appName", lang),
      appDesc: localized(metadata, "description", lang),
      briefInfo: localized(metadata, "shortDescription", lang),
      newFeatures: localized(metadata, "releaseNotes", lang),
    };
    if (!body.appName) throw new ArgumentError(`Missing appName for ${lang}`);
    const query = new URLSearchParams({ appId, releaseType: "1", releasePhase: "0" });
    assertConnectSuccess(
      await connectRequest(credential, `/publish/v3/app-language-info?${query}`, { method: "PUT", body }),
      `Update language information (${lang})`,
    );
    results.push(lang);
  }
  return results;
}

export async function uploadOfficialAsset(credential, appId, path) {
  const data = readFileSync(path);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const query = new URLSearchParams({
    appId,
    fileName: basename(path),
    sha256,
    contentLength: String(data.length),
    chineseMainlandFlag: "1",
  });
  const ticket = assertConnectSuccess(
    await connectRequest(credential, `/publish/v2/upload-url/for-obs?${query}`),
    `Get upload URL (${basename(path)})`,
  );
  const info = ticket.urlInfo;
  if (!info?.url || !info?.objectId) throw new CommandExecutionError(`Upload URL response is incomplete for ${basename(path)}`);
  const headers = Object.fromEntries(Object.entries(info.headers || {}).map(([key, value]) => [key, String(value)]));
  const response = await fetch(info.url, { method: String(info.method || "PUT").toUpperCase(), headers, body: data });
  if (!response.ok) throw new CommandExecutionError(`Upload failed for ${basename(path)}: HTTP ${response.status}`);
  return { path, objectId: String(info.objectId), bytes: data.length, sha256 };
}

export async function updateOfficialFileInfo(credential, appId, body) {
  const query = new URLSearchParams({ appId, releaseType: "1", releasePhase: "0" });
  return assertConnectSuccess(
    await connectRequest(credential, `/publish/v3/app-file-info?${query}`, { method: "PUT", body }),
    "Update application file information",
  );
}

export function defaultIconPath(cfg) {
  return resolve(projectDir(cfg), "AppScope", "resources", "base", "media", "app_icon.png");
}

export async function officialContext(args, cfg, options) {
  const context = loadPublishContext(args, cfg, options);
  const appId = await resolveOfficialAppId(context.credential, cfg);
  return { ...context, appId };
}
