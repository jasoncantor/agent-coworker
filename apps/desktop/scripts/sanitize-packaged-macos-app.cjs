const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function resolvePackagedAppPath(context) {
  const appName = context?.packager?.appInfo?.productFilename;
  if (!appName || typeof appName !== "string") {
    throw new Error("[desktop][afterPack] Missing packager appInfo.productFilename.");
  }
  const appOutDir = context?.appOutDir;
  if (!appOutDir || typeof appOutDir !== "string") {
    throw new Error("[desktop][afterPack] Missing appOutDir in electron-builder context.");
  }
  return path.join(appOutDir, `${appName}.app`);
}

function parseFindOutput(raw) {
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isDetritusBasename(basename) {
  return basename === ".DS_Store" || basename.startsWith("._");
}

function isPathInsideApp(candidatePath, appPath) {
  const appRoot = path.resolve(appPath);
  const candidate = path.resolve(candidatePath);
  return candidate === appRoot || candidate.startsWith(`${appRoot}${path.sep}`);
}

function defaultRunCommand(command, args) {
  execFileSync(command, args, { stdio: "pipe" });
}

function defaultListPaths(appPath, pattern) {
  const output = execFileSync("find", [appPath, "-type", "f", "-name", pattern, "-print"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  return parseFindOutput(output);
}

function defaultListDirectories(appPath, pattern) {
  const output = execFileSync("find", [appPath, "-type", "d", "-name", pattern, "-print"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  return parseFindOutput(output);
}

function sanitizePackagedMacApp(context, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const logger = deps.logger ?? console;
  const appPath = resolvePackagedAppPath(context);

  if (platform !== "darwin") {
    logger.info?.(`[desktop][afterPack] Skipping macOS metadata sanitization on ${platform}.`);
    return {
      ran: false,
      reason: "non-darwin",
      appPath,
      removedCount: 0,
    };
  }

  const existsSync = deps.existsSync ?? fs.existsSync;
  if (!existsSync(appPath)) {
    logger.warn?.(`[desktop][afterPack] Packaged app not found at ${appPath}; skipping metadata sanitization.`);
    return {
      ran: false,
      reason: "missing-app",
      appPath,
      removedCount: 0,
    };
  }

  const runCommand = deps.runCommand ?? defaultRunCommand;
  const listPaths = deps.listPaths ?? defaultListPaths;
  const listDirectories = deps.listDirectories ?? defaultListDirectories;
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync;

  const rawAppBundlePaths = [appPath, ...listDirectories(appPath, "*.app")];
  const appBundlePaths = Array.from(new Set(rawAppBundlePaths))
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => isPathInsideApp(candidate, appPath));

  logger.info?.(`[desktop][afterPack] Found ${appBundlePaths.length} app bundle(s) to sanitize.`);
  for (const appBundlePath of appBundlePaths) {
    runCommand("xattr", ["-cr", appBundlePath]);
  }

  const candidates = [
    ...listPaths(appPath, ".DS_Store"),
    ...listPaths(appPath, "._*"),
  ];

  let removedCount = 0;
  for (const candidate of candidates) {
    if (!isPathInsideApp(candidate, appPath)) continue;
    if (!isDetritusBasename(path.basename(candidate))) continue;
    try {
      unlinkSync(candidate);
      removedCount += 1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") continue;
      throw error;
    }
  }

  logger.info?.(`[desktop][afterPack] Sanitized ${appPath}; removed ${removedCount} detritus file(s).`);
  return {
    ran: true,
    reason: "sanitized",
    appPath,
    removedCount,
  };
}

async function sanitizePackagedMacAppAfterPack(context) {
  sanitizePackagedMacApp(context);
}

module.exports = sanitizePackagedMacAppAfterPack;
module.exports.__internal = {
  isDetritusBasename,
  isPathInsideApp,
  parseFindOutput,
  resolvePackagedAppPath,
  sanitizePackagedMacApp,
};
