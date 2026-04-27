import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAiCoworkerPaths } from "../../connect";
import { resolveOpenAiNativeConnectorsConfig } from "../../experimental/openaiNativeConnectors/flags";
import {
  CODEX_BACKEND_BASE_URL,
  type CodexAuthMaterial,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterialCoalesced,
} from "../../providers/codex-auth";
import {
  CODEX_APPS_MCP_SERVER_NAME,
  type OpenAiNativeConnector,
  type OpenAiNativeConnectorsConfig,
} from "../../shared/openaiNativeConnectors";
import type { AgentConfig, MCPServerConfig } from "../../types";
import { writeTextFileAtomic } from "../../utils/atomicFile";
import { resolveAuthHomeDir } from "../../utils/authHome";

const CONNECTORS_CONFIG_FILE_NAME = "openai-native-connectors.json";
const CHATGPT_BACKEND_BASE_URL = CODEX_BACKEND_BASE_URL.replace(/\/codex\/?$/, "");

const nonEmptyStringSchema = z.string().trim().min(1);
const nullableStringSchema = z.string().nullish();
const nullableRecordSchema = z.record(z.string(), z.unknown()).nullish();
const connectorLabelsSchema = z
  .union([z.array(z.string()), z.record(z.string(), z.string())])
  .nullish();
const connectorConfigSchema = z
  .object({
    version: z.literal(1),
    updatedAt: nonEmptyStringSchema,
    connectors: z.record(
      z.string().trim().min(1),
      z
        .object({
          enabled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const directoryAppSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nullableStringSchema,
    display_name: nullableStringSchema,
    displayName: nullableStringSchema,
    title: nullableStringSchema,
    description: nullableStringSchema,
    logo_url: nullableStringSchema,
    logoUrl: nullableStringSchema,
    logo_url_dark: nullableStringSchema,
    logoUrlDark: nullableStringSchema,
    distribution_channel: nullableStringSchema,
    distributionChannel: nullableStringSchema,
    install_url: nullableStringSchema,
    installUrl: nullableStringSchema,
    app_metadata: nullableRecordSchema,
    appMetadata: nullableRecordSchema,
    branding: nullableRecordSchema,
    labels: connectorLabelsSchema,
    visibility: nullableStringSchema,
  })
  .passthrough();

const directoryListResponseSchema = z
  .object({
    apps: z.array(directoryAppSchema).default([]),
    next_token: z.string().nullish(),
    nextToken: z.string().nullish(),
  })
  .passthrough();

export type OpenAiNativeConnectorsSnapshot = {
  connectors: OpenAiNativeConnector[];
  enabledConnectorIds: string[];
  authenticated: boolean;
  message?: string;
};

export function openAiNativeConnectorsConfigPath(config: Pick<AgentConfig, "projectCoworkDir">) {
  return path.join(config.projectCoworkDir, CONNECTORS_CONFIG_FILE_NAME);
}

function emptyConnectorsConfig(): OpenAiNativeConnectorsConfig {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    connectors: {},
  };
}

export async function readOpenAiNativeConnectorsConfig(
  config: Pick<AgentConfig, "projectCoworkDir">,
): Promise<OpenAiNativeConnectorsConfig> {
  const filePath = openAiNativeConnectorsConfigPath(config);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = connectorConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyConnectorsConfig();
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return emptyConnectorsConfig();
    throw error;
  }
}

async function writeOpenAiNativeConnectorsConfig(
  config: Pick<AgentConfig, "projectCoworkDir">,
  document: OpenAiNativeConnectorsConfig,
): Promise<void> {
  const filePath = openAiNativeConnectorsConfigPath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeTextFileAtomic(filePath, JSON.stringify(document, null, 2), { mode: 0o600 });
}

export async function setOpenAiNativeConnectorEnabled(
  config: Pick<AgentConfig, "projectCoworkDir">,
  connectorId: string,
  enabled: boolean,
): Promise<OpenAiNativeConnectorsConfig> {
  const id = connectorId.trim();
  if (!id) throw new Error("Connector id is required.");
  const current = await readOpenAiNativeConnectorsConfig(config);
  const next: OpenAiNativeConnectorsConfig = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connectors: {
      ...current.connectors,
      [id]: { enabled },
    },
  };
  await writeOpenAiNativeConnectorsConfig(config, next);
  return next;
}

export function enabledConnectorIdsFromConfig(document: OpenAiNativeConnectorsConfig): string[] {
  return Object.entries(document.connectors)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
}

async function resolveCodexAuthForConnectors(
  config: AgentConfig,
): Promise<CodexAuthMaterial | null> {
  const paths = getAiCoworkerPaths({ homedir: resolveAuthHomeDir(config) });
  let material = await readCodexAuthMaterial(paths);
  if (!material?.accessToken) return null;
  if (isTokenExpiring(material) && material.refreshToken) {
    material = await refreshCodexAuthMaterialCoalesced({
      paths,
      material,
      fetchImpl: fetch,
    });
  }
  if (isTokenExpiring(material, 0)) return null;
  return material;
}

export function codexConnectorAuthHeaders(material: CodexAuthMaterial): Record<string, string> {
  return {
    authorization: `Bearer ${material.accessToken}`,
    ...(material.accountId ? { "ChatGPT-Account-ID": material.accountId } : {}),
    ...(material.isFedrampAccount ? { "X-OpenAI-Fedramp": "true" } : {}),
  };
}

function connectorUrl(pathname: string): string {
  return `${CHATGPT_BACKEND_BASE_URL}${pathname}`;
}

function mapDirectoryApp(
  app: z.infer<typeof directoryAppSchema>,
  opts: { enabled: boolean; workspace: boolean },
): OpenAiNativeConnector {
  const name = app.name ?? app.display_name ?? app.displayName ?? app.title ?? app.id;
  const logoUrl = app.logo_url ?? app.logoUrl ?? undefined;
  const logoUrlDark = app.logo_url_dark ?? app.logoUrlDark ?? undefined;
  const distributionChannel = app.distribution_channel ?? app.distributionChannel ?? undefined;
  const installUrl = app.install_url ?? app.installUrl ?? undefined;
  const appMetadata = app.app_metadata ?? app.appMetadata ?? undefined;
  return {
    id: app.id,
    name,
    ...(app.description ? { description: app.description } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(logoUrlDark ? { logoUrlDark } : {}),
    ...(distributionChannel ? { distributionChannel } : {}),
    ...(installUrl ? { installUrl } : {}),
    ...(appMetadata ? { appMetadata } : {}),
    ...(app.labels ? { labels: app.labels } : {}),
    isWorkspaceConnector: opts.workspace,
    isEnabled: opts.enabled,
  };
}

async function fetchDirectoryPage(opts: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  token?: string;
  workspace: boolean;
}): Promise<z.infer<typeof directoryListResponseSchema>> {
  const pathAndQuery = opts.workspace
    ? "/connectors/directory/list_workspace?external_logos=true"
    : `/connectors/directory/list?${opts.token ? `token=${encodeURIComponent(opts.token)}&` : ""}external_logos=true`;
  const response = await opts.fetchImpl(connectorUrl(pathAndQuery), {
    method: "GET",
    headers: opts.headers,
  });
  if (!response.ok) {
    throw new Error(`Connector directory request failed (${response.status}).`);
  }
  const parsed = directoryListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Connector directory returned an invalid payload.");
  }
  return parsed.data;
}

async function listDirectoryConnectors(opts: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  config: OpenAiNativeConnectorsConfig;
}): Promise<OpenAiNativeConnector[]> {
  const connectors: OpenAiNativeConnector[] = [];
  let token: string | undefined;
  do {
    const page = await fetchDirectoryPage({
      fetchImpl: opts.fetchImpl,
      headers: opts.headers,
      token,
      workspace: false,
    });
    for (const app of page.apps) {
      connectors.push(
        mapDirectoryApp(app, {
          enabled: opts.config.connectors[app.id]?.enabled === true,
          workspace: false,
        }),
      );
    }
    token = page.next_token ?? page.nextToken ?? undefined;
  } while (token);
  return connectors;
}

async function listWorkspaceConnectors(opts: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  config: OpenAiNativeConnectorsConfig;
}): Promise<OpenAiNativeConnector[]> {
  try {
    const page = await fetchDirectoryPage({
      fetchImpl: opts.fetchImpl,
      headers: opts.headers,
      workspace: true,
    });
    return page.apps.map((app) =>
      mapDirectoryApp(app, {
        enabled: opts.config.connectors[app.id]?.enabled === true,
        workspace: true,
      }),
    );
  } catch {
    return [];
  }
}

function mergeConnectors(connectors: OpenAiNativeConnector[]): OpenAiNativeConnector[] {
  const byId = new Map<string, OpenAiNativeConnector>();
  for (const connector of connectors) {
    const existing = byId.get(connector.id);
    byId.set(
      connector.id,
      existing
        ? {
            ...existing,
            ...connector,
            isAccessible: existing.isAccessible === true || connector.isAccessible === true,
            isEnabled: existing.isEnabled === true || connector.isEnabled === true,
          }
        : connector,
    );
  }
  return [...byId.values()]
    .map((connector) =>
      connector.isAccessible === true ? connector : { ...connector, isEnabled: false },
    )
    .sort(
      (left, right) =>
        Number(right.isAccessible === true) - Number(left.isAccessible === true) ||
        left.name.localeCompare(right.name),
    );
}

async function listAccessibleConnectors(opts: {
  material: CodexAuthMaterial;
  connectorConfig: OpenAiNativeConnectorsConfig;
}): Promise<OpenAiNativeConnector[]> {
  try {
    const { loadMCPTools } = await import("../../mcp/index");
    const loaded = await loadMCPTools(
      [
        {
          name: CODEX_APPS_MCP_SERVER_NAME,
          transport: {
            type: "http",
            url: `${CHATGPT_BACKEND_BASE_URL}/wham/apps`,
            headers: codexConnectorAuthHeaders(opts.material),
          },
          retries: 0,
          auth: { type: "none" },
        },
      ],
      { sleep: async () => {} },
    );
    try {
      const byId = new Map<string, OpenAiNativeConnector>();
      for (const tool of Object.values(loaded.tools)) {
        if (typeof tool !== "object" || tool === null) continue;
        const meta = (tool as Record<string, unknown>)._meta;
        if (typeof meta !== "object" || meta === null) continue;
        const metaRecord = meta as Record<string, unknown>;
        const id = typeof metaRecord.connector_id === "string" ? metaRecord.connector_id : "";
        if (!id || byId.has(id)) continue;
        const name =
          typeof metaRecord.connector_name === "string" && metaRecord.connector_name.trim()
            ? metaRecord.connector_name.trim()
            : id;
        const description =
          typeof metaRecord.connector_description === "string"
            ? metaRecord.connector_description
            : undefined;
        byId.set(id, {
          id,
          name,
          ...(description ? { description } : {}),
          isAccessible: true,
          isEnabled: opts.connectorConfig.connectors[id]?.enabled === true,
        });
      }
      return [...byId.values()];
    } finally {
      await loaded.close();
    }
  } catch {
    return [];
  }
}

export async function listOpenAiNativeConnectors(opts: {
  config: AgentConfig;
  fetchImpl?: typeof fetch;
  discoverAccessible?: boolean;
}): Promise<OpenAiNativeConnectorsSnapshot> {
  const connectorConfig = await readOpenAiNativeConnectorsConfig(opts.config);
  const enabledConnectorIds = enabledConnectorIdsFromConfig(connectorConfig);
  if (!resolveOpenAiNativeConnectorsConfig(opts.config)) {
    return {
      connectors: [],
      enabledConnectorIds: [],
      authenticated: false,
      message: "OpenAI native connectors are disabled. Enable the experimental feature flag first.",
    };
  }
  const material = await resolveCodexAuthForConnectors(opts.config);
  if (!material) {
    return {
      connectors: [],
      enabledConnectorIds,
      authenticated: false,
      message: "Sign in to Codex before using OpenAI native connectors.",
    };
  }

  const headers = codexConnectorAuthHeaders(material);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const directoryConnectors = await listDirectoryConnectors({
    fetchImpl,
    headers,
    config: connectorConfig,
  });
  const workspaceConnectors = await listWorkspaceConnectors({
    fetchImpl,
    headers,
    config: connectorConfig,
  });
  const accessibleConnectors =
    opts.discoverAccessible === false
      ? []
      : await listAccessibleConnectors({ material, connectorConfig });

  return {
    connectors: mergeConnectors([
      ...accessibleConnectors,
      ...directoryConnectors,
      ...workspaceConnectors,
    ]),
    enabledConnectorIds: enabledConnectorIds.filter((id) =>
      accessibleConnectors.some((connector) => connector.id === id),
    ),
    authenticated: true,
  };
}

export async function buildCodexAppsMcpServer(
  config: AgentConfig,
): Promise<(MCPServerConfig & { enabledConnectorIds?: string[] }) | null> {
  if (!resolveOpenAiNativeConnectorsConfig(config)) return null;
  const connectorConfig = await readOpenAiNativeConnectorsConfig(config);
  const enabledConnectorIds = enabledConnectorIdsFromConfig(connectorConfig);
  if (enabledConnectorIds.length === 0) return null;
  const material = await resolveCodexAuthForConnectors(config);
  if (!material) return null;

  return {
    name: CODEX_APPS_MCP_SERVER_NAME,
    transport: {
      type: "http",
      url: `${CHATGPT_BACKEND_BASE_URL}/wham/apps`,
      headers: codexConnectorAuthHeaders(material),
    },
    retries: 1,
    auth: { type: "none" },
    enabledConnectorIds,
  };
}
