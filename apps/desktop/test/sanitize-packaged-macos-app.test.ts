import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sanitizeHook = require("../scripts/sanitize-packaged-macos-app.cjs") as {
  __internal: {
    resolvePackagedAppPath: (context: unknown) => string;
    sanitizePackagedMacApp: (
      context: unknown,
      deps?: {
        platform?: string;
        logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
        existsSync?: (target: string) => boolean;
        runCommand?: (command: string, args: string[]) => void;
        listPaths?: (appPath: string, pattern: string) => string[];
        listDirectories?: (appPath: string, pattern: string) => string[];
        unlinkSync?: (target: string) => void;
      }
    ) => { ran: boolean; reason: string; appPath: string; removedCount: number };
  };
};

describe("desktop macOS packaging sanitizer", () => {
  test("resolves the packaged app path from electron-builder context", () => {
    const appPath = sanitizeHook.__internal.resolvePackagedAppPath({
      appOutDir: "/tmp/release/mac-arm64",
      packager: {
        appInfo: {
          productFilename: "Cowork",
        },
      },
    });

    expect(appPath).toBe(path.join("/tmp/release/mac-arm64", "Cowork.app"));
  });

  test("skips cleanup on non-darwin platforms", () => {
    let ranCommand = false;
    let listed = false;
    let unlinked = false;

    const result = sanitizeHook.__internal.sanitizePackagedMacApp(
      {
        appOutDir: "/tmp/release/mac-arm64",
        packager: { appInfo: { productFilename: "Cowork" } },
      },
      {
        platform: "linux",
        logger: { info: () => {}, warn: () => {} },
        existsSync: () => true,
        runCommand: () => {
          ranCommand = true;
        },
        listPaths: () => {
          listed = true;
          return [];
        },
        listDirectories: () => {
          listed = true;
          return [];
        },
        unlinkSync: () => {
          unlinked = true;
        },
      }
    );

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("non-darwin");
    expect(ranCommand).toBe(false);
    expect(listed).toBe(false);
    expect(unlinked).toBe(false);
  });

  test("sanitizes only files inside the packaged app bundle", () => {
    const appPath = path.join("/tmp/release/mac-arm64", "Cowork.app");
    const insideDsStore = path.join(appPath, "Contents", ".DS_Store");
    const insideAppleDouble = path.join(appPath, "Contents", "Resources", "._icon.icns");
    const outsideDsStore = path.join("/tmp/release/mac-arm64", ".DS_Store");
    const outsideAppleDouble = path.join("/tmp/release/mac-arm64", "._Cowork");
    const nestedHelperApp = path.join(appPath, "Contents", "Frameworks", "Cowork Helper (GPU).app");
    const outsideAppBundle = path.join("/tmp/release/mac-arm64", "NotCowork.app");

    const commandCalls: Array<{ command: string; args: string[] }> = [];
    const unlinkCalls: string[] = [];

    const result = sanitizeHook.__internal.sanitizePackagedMacApp(
      {
        appOutDir: "/tmp/release/mac-arm64",
        packager: { appInfo: { productFilename: "Cowork" } },
      },
      {
        platform: "darwin",
        logger: { info: () => {}, warn: () => {} },
        existsSync: () => true,
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
        },
        listDirectories: (_targetAppPath, pattern) => {
          if (pattern === "*.app") return [appPath, nestedHelperApp, outsideAppBundle];
          return [];
        },
        listPaths: (_targetAppPath, pattern) => {
          if (pattern === ".DS_Store") return [insideDsStore, outsideDsStore];
          if (pattern === "._*") return [insideAppleDouble, outsideAppleDouble];
          return [];
        },
        unlinkSync: (target) => {
          unlinkCalls.push(target);
        },
      }
    );

    expect(result.ran).toBe(true);
    expect(result.reason).toBe("sanitized");
    expect(result.appPath).toBe(appPath);
    expect(result.removedCount).toBe(2);
    expect(commandCalls).toEqual([
      {
        command: "xattr",
        args: ["-cr", appPath],
      },
      {
        command: "xattr",
        args: ["-cr", nestedHelperApp],
      },
    ]);
    expect(unlinkCalls).toEqual([insideDsStore, insideAppleDouble]);
  });
});
