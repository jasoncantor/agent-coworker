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

export function resolveTrayIconPath(
  rootDir: string,
  options: ResolveTrayIconPathOptions = {},
): string {
  const isPackaged = options.isPackaged ?? process.env.COWORK_IS_PACKAGED === "true";
  const platform = options.platform ?? process.platform;
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const trayIconFilename = resolveTrayIconFilename(platform);
  if (isPackaged) {
    return pathModule.join(
      options.resourcesPath ?? process.resourcesPath,
      "tray",
      trayIconFilename,
    );
  }

  const pathExists = options.pathExists ?? existsSync;
  const candidates = [
    pathModule.resolve(rootDir, "../../build", trayIconFilename),
    pathModule.resolve(rootDir, "../build", trayIconFilename),
  ];
  return candidates.find((candidatePath) => pathExists(candidatePath)) ?? candidates[0];
}
