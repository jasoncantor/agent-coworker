import pkg from "../package.json";

export function resolveVersion(env: Record<string, string | undefined> = process.env): string {
  const explicitVersion = env.COWORK_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  return pkg.version;
}

export const VERSION: string = resolveVersion();
