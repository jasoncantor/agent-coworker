import fs from "node:fs";
import path from "node:path";

import type { AgentConfig } from "../types";
import { canonicalWorkspacePath, sameWorkspacePath } from "../utils/workspacePath";

type ActiveWorkspaceContext = {
  workspaceRoot: string;
  executionCwd: string;
  gitRoot?: string;
  workingDirectoryRelation: string;
  outputDirectory?: string;
  effectiveUploadsDirectory: string;
  projectAgentDir: string;
};

function findGitRootSync(startDir: string): string | undefined {
  let currentDir = path.resolve(startDir);

  while (true) {
    const gitPath = path.join(currentDir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return currentDir;
      }
    } catch {
      // Fail open: omit the git root line when lookup fails.
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

function deriveWorkingDirectoryRelation(
  workspaceRoot: string,
  executionCwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (sameWorkspacePath(workspaceRoot, executionCwd, platform)) {
    return "same as workspace root";
  }

  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const normalizedWorkspaceRoot = canonicalWorkspacePath(workspaceRoot, platform);
  const normalizedExecutionCwd = canonicalWorkspacePath(executionCwd, platform);
  const normalizedRelative = pathImpl.relative(normalizedWorkspaceRoot, normalizedExecutionCwd);

  if (
    normalizedRelative
    && normalizedRelative !== ".."
    && !normalizedRelative.startsWith(`..${pathImpl.sep}`)
    && !pathImpl.isAbsolute(normalizedRelative)
  ) {
    const displayRelative = pathImpl.relative(
      pathImpl.resolve(workspaceRoot),
      pathImpl.resolve(executionCwd),
    );
    return `inside workspace root at ${displayRelative}`;
  }

  return "outside workspace root";
}

export function deriveActiveWorkspaceContext(config: AgentConfig): ActiveWorkspaceContext {
  const workspaceRoot = path.dirname(config.projectAgentDir);
  const executionCwd = config.workingDirectory;

  return {
    workspaceRoot,
    executionCwd,
    gitRoot: findGitRootSync(workspaceRoot),
    workingDirectoryRelation: deriveWorkingDirectoryRelation(workspaceRoot, executionCwd),
    outputDirectory: config.outputDirectory,
    effectiveUploadsDirectory: config.uploadsDirectory ?? path.resolve(config.workingDirectory, "User Uploads"),
    projectAgentDir: config.projectAgentDir,
  };
}

export function renderActiveWorkspaceContextSection(
  config: AgentConfig | null | undefined,
): string {
  if (!config) return "";

  const context = deriveActiveWorkspaceContext(config);
  const lines: string[] = [
    "## Active Workspace Context",
    "",
    `- Workspace root: ${context.workspaceRoot}`,
    `- Execution working directory: ${context.executionCwd}`,
  ];

  if (context.gitRoot) {
    lines.push(`- Git root: ${context.gitRoot}`);
  }

  lines.push(`- Working directory relation: ${context.workingDirectoryRelation}`);

  if (context.outputDirectory) {
    lines.push(`- Output directory: ${context.outputDirectory}`);
  }

  lines.push(
    `- Uploads directory: ${context.effectiveUploadsDirectory}`,
    `- Project config + workspace memory: ${context.projectAgentDir}`,
    "- Path rule: `shell`, `read`, `write`, and `search` default to the execution working directory.",
    `- Path rule: project config and workspace memory live under ${context.projectAgentDir}.`,
  );

  return lines.join("\n");
}
