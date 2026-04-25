import os from "node:os";
import path from "node:path";

export function resolveCoworkHomedir(userCoworkDir?: string): string {
  const fallback = os.homedir();
  const trimmed = userCoworkDir?.trim();
  if (!trimmed) return fallback;

  const normalized = path.normalize(trimmed);
  return path.basename(normalized) === ".cowork" ? path.dirname(normalized) : fallback;
}
