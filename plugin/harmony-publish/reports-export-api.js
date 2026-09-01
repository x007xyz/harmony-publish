import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { connectRequest, loadCredential, resolveOfficialAppId } from "./agc-api.js";
import { SITE, projectConfig } from "./shared.js";

const REPORTS = {
  downloads: {
    endpoint: "appDownloadAnalysisExport",
    filename: "downloads.csv",
    query: { groupBy: "date" },
  },
  "user-account": {
    endpoint: "userAnalysisExport",
    filename: "users-account.csv",
    query: { groupBy: "date", userDimension: "account" },
  },
  "user-device": {
    endpoint: "userAnalysisExport",
    filename: "users-device.csv",
    query: { groupBy: "date", userDimension: "device" },
  },
  "install-failed": {
    endpoint: "installFailedAnalysisExport",
    filename: "install-failed.csv",
    query: { groupBy: "dateAndCodeAndReason" },
  },
};

function dateArg(value, name) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) throw new ArgumentError(`--${name} must use YYYYMMDD`);
  return text;
}

function selectedReports(value) {
  const name = String(value || "all").trim();
  if (name === "all") return Object.keys(REPORTS);
  if (!REPORTS[name]) throw new ArgumentError(`Unknown report: ${name}`);
  return [name];
}

function assertReportSuccess(payload, report) {
  const code = Number(payload?.ret?.code ?? 0);
  if (code !== 0) {
    throw new CommandExecutionError(
      `${report} report failed: code=${code}, message=${payload?.ret?.msg || "unknown"}`,
    );
  }
  if (!payload?.fileURL) {
    throw new CommandExecutionError(`${report} report response did not include fileURL`);
  }
  return String(payload.fileURL);
}

async function downloadReport(url, output) {
  const response = await fetch(url);
  if (!response.ok) throw new CommandExecutionError(`Report download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, data, { mode: 0o600 });
  return data.length;
}

cli({
  site: SITE,
  name: "reports-export",
  description: "Export read-only HarmonyOS distribution, user, and install-failure reports through the official Reports API",
  access: "read",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "table",
  args: [
    { name: "project", default: "", help: "projects.json key or project path" },
    { name: "app-id", default: "", help: "APP ID for an unregistered project; requires --output-dir" },
    { name: "credential", default: "", help: "Service Account private.json" },
    { name: "start", default: "", help: "UTC start date in YYYYMMDD" },
    { name: "end", default: "", help: "UTC end date in YYYYMMDD" },
    { name: "report", default: "all", choices: ["all", ...Object.keys(REPORTS)], help: "Report to export" },
    { name: "language", default: "zh-CN", choices: ["zh-CN", "en-US", "ru-RU"], help: "CSV header language" },
    { name: "output-dir", default: "", help: "Directory for downloaded CSV files" },
  ],
  columns: ["status", "backend", "appId", "report", "start", "end", "output", "bytes"],
  func: async (args) => {
    const directAppId = String(args["app-id"] || "").trim();
    const cfg = directAppId ? { projectRoot: process.cwd(), appId: directAppId } : projectConfig(args);
    const { credential } = loadCredential(args, cfg, true);
    const appId = directAppId || await resolveOfficialAppId(credential, cfg);
    const start = dateArg(args.start, "start");
    const end = dateArg(args.end, "end");
    if (start > end) throw new ArgumentError("--start must not be later than --end");
    if (directAppId && !String(args["output-dir"] || "").trim()) {
      throw new ArgumentError("--output-dir is required when using --app-id");
    }
    const outputDir = resolve(String(args["output-dir"] || join(cfg.projectRoot, "reports", "appgallery", `${start}-${end}`)));
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true, mode: 0o700 });

    const rows = [];
    for (const name of selectedReports(args.report)) {
      const report = REPORTS[name];
      const query = new URLSearchParams({
        startTime: start,
        endTime: end,
        timeType: "day",
        language: String(args.language || "zh-CN"),
        exportType: "CSV",
        ...report.query,
      });
      const payload = await connectRequest(
        credential,
        `/report/harmony-report/v1/harmony/${report.endpoint}/${appId}?${query}`,
      );
      const fileURL = assertReportSuccess(payload, name);
      const output = join(outputDir, report.filename);
      const bytes = await downloadReport(fileURL, output);
      rows.push({ status: "ready", backend: "official-reports-api", appId, report: name, start, end, output, bytes });
    }
    return rows;
  },
});
