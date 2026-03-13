import fs from "node:fs/promises";
import path from "node:path";

import { writeTextFileAtomic } from "../../utils/atomicFile";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type ConversationSearchPaths = {
  rootDir: string;
  modelsDir: string;
  locksDir: string;
  stateFile: string;
  indexDbPath: string;
};

export function getConversationSearchPaths(coworkRootDir: string): ConversationSearchPaths {
  const rootDir = path.join(coworkRootDir, "conversation-search");
  return {
    rootDir,
    modelsDir: path.join(rootDir, "models"),
    locksDir: path.join(rootDir, "locks"),
    stateFile: path.join(rootDir, "state.json"),
    indexDbPath: path.join(rootDir, "index.sqlite"),
  };
}

export async function ensureConversationSearchDirs(paths: ConversationSearchPaths): Promise<void> {
  for (const dir of [paths.rootDir, paths.modelsDir, paths.locksDir]) {
    await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      await fs.chmod(dir, PRIVATE_DIR_MODE);
    } catch {
      // best effort only
    }
  }
}

export async function writeConversationSearchJson(filePath: string, payload: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch {
    // best effort only
  }
}

export function workspaceLockKey(workspacePath: string): string {
  return Bun.hash(workspacePath).toString(16);
}
