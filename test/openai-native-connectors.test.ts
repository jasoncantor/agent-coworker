import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../src/connect";
import { writeCodexAuthMaterial } from "../src/providers/codex-auth";
import {
  listOpenAiNativeConnectors,
  openAiNativeConnectorsConfigPath,
  setOpenAiNativeConnectorEnabled,
} from "../src/server/connectors/openaiNativeConnectors";
import type { AgentConfig } from "../src/types";

function makeConfig(workspaceRoot: string, home: string): AgentConfig {
  return {
    provider: "codex-cli",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5.4",
    workingDirectory: workspaceRoot,
    outputDirectory: path.join(workspaceRoot, "output"),
    uploadsDirectory: path.join(workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(workspaceRoot, ".cowork"),
    userCoworkDir: path.join(home, ".cowork"),
    builtInDir: workspaceRoot,
    builtInConfigDir: path.join(workspaceRoot, "config"),
    skillsDirs: [path.join(home, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    experimentalFeatures: { openAiNativeConnectors: true },
  };
}

describe("OpenAI native connectors", () => {
  test("lists paginated directory connectors and keeps directory-only entries disabled", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-home-"));
    const config = makeConfig(workspaceRoot, home);
    await writeCodexAuthMaterial(getAiCoworkerPaths({ homedir: home }), {
      issuer: "https://auth.example.invalid",
      clientId: "client-id",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accountId: "acct-1",
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    await setOpenAiNativeConnectorEnabled(config, "connector_gmail", true);

    const requestedUrls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requestedUrls.push(String(url));
      expect(init?.headers).toMatchObject({
        authorization: "Bearer access-token",
        "ChatGPT-Account-ID": "acct-1",
      });
      if (String(url).includes("token=page-2")) {
        return new Response(
          JSON.stringify({
            apps: [
              {
                id: "connector_dropbox",
                name: "Dropbox",
                description: null,
                logoUrl: null,
                logoUrlDark: null,
                appMetadata: null,
                branding: null,
                labels: { category: "files" },
              },
            ],
            nextToken: null,
          }),
        );
      }
      if (String(url).includes("list_workspace")) {
        return new Response(JSON.stringify({ apps: [{ id: "connector_workspace", name: "WS" }] }));
      }
      return new Response(
        JSON.stringify({
          apps: [{ id: "connector_gmail", name: "Gmail", description: "Mail" }],
          nextToken: "page-2",
        }),
      );
    }) as typeof fetch;

    const snapshot = await listOpenAiNativeConnectors({
      config,
      fetchImpl,
      discoverAccessible: false,
    });

    expect(snapshot.authenticated).toBe(true);
    expect(snapshot.enabledConnectorIds).toEqual([]);
    expect(snapshot.connectors.map((connector) => connector.id).sort()).toEqual([
      "connector_dropbox",
      "connector_gmail",
      "connector_workspace",
    ]);
    expect(
      snapshot.connectors.find((connector) => connector.id === "connector_gmail")?.isEnabled,
    ).toBe(false);
    expect(requestedUrls.some((url) => url.includes("token=page-2"))).toBe(true);
  });

  test("persists connector enabled state in the workspace .cowork directory", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-config-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-config-home-"));
    const config = makeConfig(workspaceRoot, home);

    await setOpenAiNativeConnectorEnabled(config, "connector_dropbox", true);

    const persisted = JSON.parse(
      await fs.readFile(openAiNativeConnectorsConfigPath(config), "utf-8"),
    );
    expect(persisted.connectors.connector_dropbox.enabled).toBe(true);
  });
});
