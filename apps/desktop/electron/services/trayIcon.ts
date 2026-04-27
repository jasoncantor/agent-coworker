import { existsSync } from "node:fs";
import path from "node:path";

type ResolveTrayIconPathOptions = {
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  pathExists?: (candidatePath: string) => boolean;
};

function resolveTrayIconFilename(platform: NodeJS.Platform): string {
  return platform === "win32" ? "icon.ico" : "icon.png";
}

function pathApiForTarget(platform: NodeJS.Platform, samplePath: string) {
  if (platform !== "win32" && samplePath.startsWith("/")) {
    return path.posix;
  }
  if (platform === "win32" || /^[A-Za-z]:[\\/]/.test(samplePath) || samplePath.includes("\\")) {
    return path.win32;
  }
  return path;
}

export function resolveTrayIconPath(
  rootDir: string,
  options: ResolveTrayIconPathOptions = {},
): string {
  const isPackaged = options.isPackaged ?? process.env.COWORK_IS_PACKAGED === "true";
  const platform = options.platform ?? process.platform;
  const trayIconFilename = resolveTrayIconFilename(platform);
  if (isPackaged) {
    const resourcesPath = options.resourcesPath ?? process.resourcesPath;
    return pathApiForTarget(platform, resourcesPath).join(resourcesPath, "tray", trayIconFilename);
  }

  const pathExists = options.pathExists ?? existsSync;
  const targetPath = pathApiForTarget(platform, rootDir);
  const candidates = [
    targetPath.resolve(rootDir, "../../build", trayIconFilename),
    targetPath.resolve(rootDir, "../build", trayIconFilename),
  ];
  return candidates.find((candidatePath) => pathExists(candidatePath)) ?? candidates[0];
}
