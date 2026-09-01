#!/usr/bin/env node
/**
 * generate-copy.mjs — 为 AGC 托管隐私协议预生成文案参数（AI 生成参数的底座）
 *
 * 从 projects.json + release/appgallery.metadata.json + remarks 自动提取应用信息，
 * 按统一模板生成协议文案。SKILL 流程要求：运行本脚本后，由 AI 基于应用真实功能
 * 审核/润色输出，再交给 create-agreement.mjs 一次性执行。
 *
 * 用法:
 *   node generate-copy.mjs --project <key|路径> [--email <邮箱>] [--out <输出.json>]
 *   (--out 缺省时打印到 stdout)
 *
 * 输出 JSON 字段（create-agreement.mjs 的输入）:
 *   name       协议名称, 如「发了么隐私政策」
 *   intro      产品简介（第一段）
 *   path       服务模式设置页面路径
 *   mode       服务模式选项, 默认「不收集个人信息」
 *   functions  产品功能列表（编辑器可用 ≤2 项）
 *   server     服务器所在国家/位置
 *   contact    自定义联系内容
 *   email      公开隐私联系邮箱
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "../..");
const PROJECTS = join(SKILL_DIR, "projects.json");
const DEFAULT_EMAIL = "review@example.com";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

function loadProjects() {
  return JSON.parse(readFileSync(PROJECTS, "utf8"));
}

function resolveProject(key) {
  const projects = loadProjects();
  if (projects[key]) return { key, cfg: projects[key] };
  // 支持路径或 displayName
  for (const [k, v] of Object.entries(projects)) {
    if (v.projectRoot === key || v.displayName === key) return { key: k, cfg: v };
  }
  throw new Error(`project not found in ${PROJECTS}: ${key}`);
}

function loadMetadata(cfg) {
  const path = join(cfg.projectRoot, "release", "appgallery.metadata.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function sentences(text) {
  return String(text || "")
    .split(/[。；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从描述中提取 2 条 4–60 字的简洁功能句 */
function extractFunctions(description, short) {
  const out = [];
  for (const sentence of sentences(description).slice(0, 4)) {
    const cleaned = sentence
      .replace(/^你可以|^您可以|^应用会|^内置/, "")
      .trim();
    if (cleaned.length >= 4 && cleaned.length <= 60) out.push(cleaned);
    if (out.length >= 2) break;
  }
  if (out.length === 0) out.push(short);
  return out;
}

function generate(key, cfg, email) {
  const metadata = loadMetadata(cfg);
  const appName = String(
    metadata.appName?.["zh-CN"] || cfg.appName || cfg.displayName || key
  ).trim();
  const mainName = appName.split(/[：:]/)[0].trim() || appName;
  const short = String(metadata.shortDescription?.["zh-CN"] || "").trim() ||
    `${mainName}：本地数据管理工具`;
  const description = String(
    metadata.description?.["zh-CN"] || cfg.remarks || ""
  ).trim();
  const functions = extractFunctions(description, short);

  return {
    name: `${mainName}隐私政策`,
    intro: `${short}。所有数据均在设备本地处理，无需注册账号，不联网、不上传任何数据。`,
    path: "本应用不设置服务模式，所有数据均在设备本地处理",
    mode: "不收集个人信息",
    functions,
    server: "用户设备本地（不上传至服务器）",
    contact: `隐私问题请联系：${email}。本应用不注册账号、不上传数据、不收集个人信息。`,
    email,
  };
}

const key = arg("--project");
if (!key) {
  console.error("usage: node generate-copy.mjs --project <key|path> [--email <email>] [--out <file.json>]");
  process.exit(2);
}
const { key: resolvedKey, cfg } = resolveProject(key);
const email = arg("--email", DEFAULT_EMAIL);
const copy = generate(resolvedKey, cfg, email);

const out = arg("--out");
if (out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(out), JSON.stringify(copy, null, 2) + "\n");
  console.log(`copy written to ${resolve(out)}`);
} else {
  console.log(JSON.stringify(copy, null, 2));
}
