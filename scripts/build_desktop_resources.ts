import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSidecarManifest,
  resolvePackagedSidecarFilename,
} from "../apps/desktop/electron/services/sidecar";

const CACHE_VERSION = 1;

type DesktopResourcesCache = {
  version: number;
  includeDocs: boolean;
  sidecarFingerprint: string;
  promptsFingerprint: string;
  configFingerprint: string;
  docsFingerprint: string | null;
};

async function rmrf(p: string) {
  await fs.rm(p, { recursive: true, force: true });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string) {
  const anyFs = fs as typeof fs & {
    cp?: (src: string, dest: string, options?: { recursive?: boolean }) => Promise<void>;
  };
  if (typeof anyFs.cp === "function") {
    await anyFs.cp(src, dest, { recursive: true });
    return;
  }

  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function walkForFingerprint(target: string, relativeTo: string, acc: string[]): Promise<void> {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      await walkForFingerprint(path.join(target, entry.name), relativeTo, acc);
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  const relative = path.relative(relativeTo, target);
  acc.push(`${relative}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
}

async function fingerprintInputs(targets: string[], root: string): Promise<string> {
  const acc: string[] = [];
  for (const target of targets) {
    if (!(await pathExists(target))) {
      acc.push(`${path.relative(root, target)}:missing`);
      continue;
    }
    await walkForFingerprint(target, root, acc);
  }
  const hash = createHash("sha256");
  hash.update(acc.join("\n"));
  return hash.digest("hex");
}

async function loadCache(cachePath: string): Promise<DesktopResourcesCache | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopResourcesCache>;
    if (
      parsed.version !== CACHE_VERSION
      || typeof parsed.includeDocs !== "boolean"
      || typeof parsed.sidecarFingerprint !== "string"
      || typeof parsed.promptsFingerprint !== "string"
      || typeof parsed.configFingerprint !== "string"
      || (parsed.docsFingerprint !== null && typeof parsed.docsFingerprint !== "string")
    ) {
      return null;
    }
    return parsed as DesktopResourcesCache;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: DesktopResourcesCache): Promise<void> {
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function syncCopiedDir(opts: {
  label: string;
  src: string;
  dest: string;
  previousFingerprint: string | null;
  nextFingerprint: string;
}): Promise<void> {
  const needsCopy =
    opts.previousFingerprint !== opts.nextFingerprint
    || !(await pathExists(opts.dest));
  if (!needsCopy) {
    console.log(`[resources] ${opts.label}: cached`);
    return;
  }

  await rmrf(opts.dest);
  await copyDir(opts.src, opts.dest);
  console.log(`[resources] ${opts.label}: updated`);
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const includeDocs = process.env.COWORK_BUNDLE_DESKTOP_DOCS === "1";
  const cachePath = path.join(distDir, ".desktop-resources-cache.json");

  await fs.mkdir(distDir, { recursive: true });
  await rmrf(path.join(distDir, "server"));

  const cache = await loadCache(cachePath);

  const sidecarInputs = [
    path.join(root, "src"),
    path.join(root, "config"),
    path.join(root, "prompts"),
    path.join(root, "apps", "desktop", "electron", "services", "sidecar.ts"),
    path.join(root, "package.json"),
    path.join(root, "bun.lock"),
    path.join(root, "tsconfig.json"),
  ];
  const promptsSrc = path.join(root, "prompts");
  const configSrc = path.join(root, "config");
  const docsSrc = path.join(root, "docs");
  const promptsFingerprint = await fingerprintInputs([promptsSrc], root);
  const configFingerprint = await fingerprintInputs([configSrc], root);
  const docsFingerprint = includeDocs ? await fingerprintInputs([docsSrc], root) : null;
  const sidecarFingerprint = await fingerprintInputs(sidecarInputs, root);

  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  const sidecarOutfile = path.join(desktopBinariesDir, resolvePackagedSidecarFilename());
  const sidecarManifestPath = path.join(desktopBinariesDir, "cowork-server-manifest.json");
  const sidecarNeedsBuild =
    cache?.sidecarFingerprint !== sidecarFingerprint
    || !(await pathExists(sidecarOutfile))
    || !(await pathExists(sidecarManifestPath));

  if (sidecarNeedsBuild) {
    const entry = path.join(root, "src", "server", "index.ts");
    await rmrf(desktopBinariesDir);
    await fs.mkdir(desktopBinariesDir, { recursive: true });

    const manifest = buildSidecarManifest();
    const compileArgs = [
      "bun",
      "build",
      entry,
      "--compile",
      "--outfile",
      sidecarOutfile,
      "--env",
      "COWORK_DESKTOP_BUNDLE*",
      "--target",
      "bun",
    ];
    if (process.platform === "win32") {
      compileArgs.push("--windows-hide-console");
    }

    const sidecarProc = Bun.spawn(compileArgs, {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
    });
    const sidecarCode = await sidecarProc.exited;
    if (sidecarCode !== 0) {
      process.exit(sidecarCode);
    }

    await fs.writeFile(sidecarManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[resources] sidecar: rebuilt ${path.relative(root, sidecarOutfile)}`);
  } else {
    console.log("[resources] sidecar: cached");
  }

  const promptsDest = path.join(distDir, "prompts");
  const configDest = path.join(distDir, "config");
  await rmrf(path.join(distDir, "skills"));

  await syncCopiedDir({
    label: "prompts",
    src: promptsSrc,
    dest: promptsDest,
    previousFingerprint: cache?.promptsFingerprint ?? null,
    nextFingerprint: promptsFingerprint,
  });

  await syncCopiedDir({
    label: "config",
    src: configSrc,
    dest: configDest,
    previousFingerprint: cache?.configFingerprint ?? null,
    nextFingerprint: configFingerprint,
  });

  const docsDest = path.join(distDir, "docs");
  if (!includeDocs) {
    await rmrf(docsDest);
    console.log("[resources] docs: disabled");
  } else {
    await syncCopiedDir({
      label: "docs",
      src: docsSrc,
      dest: docsDest,
      previousFingerprint: cache?.docsFingerprint ?? null,
      nextFingerprint: docsFingerprint!,
    });
  }

  await writeCache(cachePath, {
    version: CACHE_VERSION,
    includeDocs,
    sidecarFingerprint,
    promptsFingerprint,
    configFingerprint,
    docsFingerprint,
  });

  console.log("[resources] skipped dist/server desktop bundle (unused at runtime)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
