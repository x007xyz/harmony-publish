#!/usr/bin/env node
/**
 * Configure the "release" signing product of a HarmonyOS project using the
 * shared release keystore shipped with the harmony-publish skill.
 *
 * Usage:
 *   node configure-release-signing.mjs --project <projectRoot> \
 *       [--target <relative build-profile path>] [--profile <p7b path>]
 *
 * --project : HarmonyOS project root (native: project root; Flutter: .../ohos)
 * --target  : build-profile.json5 relative to --project (default: build-profile.json5;
 *             Flutter projects pass ohos/build-profile.json5)
 * --profile : downloaded release Profile (.p7b) path (default:
 *             <projectRoot>/release/signing/<Name>Release.p7b — pass explicitly)
 *
 * Credentials: storePassword/keyPassword come from AIMosaic/build-profile.json5
 * (the shared credentials source next to the projects); the keystore and
 * certificate come from <skill>/certs/ (release.p12 + release.cer).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const projectRoot = resolve(option("project") || ".");
const targetRel = option("target") || "build-profile.json5";
const profilePath = resolve(
  option("profile") || join(projectRoot, "release", "signing", "Release.p7b"),
);
const harmonyRoot = resolve(projectRoot, "..");
const sourcePath = resolve(harmonyRoot, "AIMosaic", "build-profile.json5");
const targetPath = resolve(projectRoot, targetRel);
const certsDir = resolve(import.meta.dirname, "..", "certs");
const storeFile = join(certsDir, "release.p12");
const certpath = join(certsDir, "release.cer");

function readJson5Object(path) {
  const source = readFileSync(path, "utf8");
  return vm.runInNewContext(`(${source})`, Object.create(null), {
    filename: path,
    timeout: 1000,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const source = readJson5Object(sourcePath);
const target = readJson5Object(targetPath);
const sourceRelease = source.app?.signingConfigs?.find((item) => item.name === "release");

if (!sourceRelease?.material?.storePassword || !sourceRelease?.material?.keyPassword) {
  throw new Error("Reusable release signing credentials were not found");
}

const releaseSigning = clone(sourceRelease);
releaseSigning.material.storeFile = storeFile;
releaseSigning.material.certpath = certpath;
releaseSigning.material.profile = profilePath;
releaseSigning.material.keyAlias = "release";
releaseSigning.material.signAlg = "SHA256withECDSA";

target.app.signingConfigs = [
  ...target.app.signingConfigs.filter((item) => item.name !== "release"),
  releaseSigning,
];

const defaultProduct = target.app.products.find((item) => item.name === "default");
if (!defaultProduct) throw new Error("Default product was not found");
const releaseProduct = {
  ...clone(defaultProduct),
  name: "release",
  signingConfig: "release",
};
target.app.products = [
  ...target.app.products.filter((item) => item.name !== "release"),
  releaseProduct,
];

for (const module of target.modules || []) {
  for (const buildTarget of module.targets || []) {
    if (!Array.isArray(buildTarget.applyToProducts)) continue;
    if (!buildTarget.applyToProducts.includes("release")) {
      buildTarget.applyToProducts.push("release");
    }
  }
}

writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`);
console.log(JSON.stringify({
  configured: true,
  targetPath,
  product: "release",
  keyAlias: "release",
  profile: profilePath,
  certpath,
  storeFile,
}));
