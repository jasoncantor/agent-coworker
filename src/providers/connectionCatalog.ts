import { getAiCoworkerPaths, readConnectionStore, type AiCoworkerPaths } from "../connect";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { defaultSupportedModel, listSupportedModels, type SupportedModel } from "../models/registry";
import { readCodexAuthMaterial } from "./codex-auth";
import { getOpenCodeDisplayName } from "./opencodeShared";
import { discoverAwsBedrockProxyModels, resolveAwsBedrockProxyBaseUrl } from "./awsBedrockProxyShared";

export type ProviderCatalogModelEntry = Pick<
  SupportedModel,
  "id" | "displayName" | "knowledgeCutoff" | "supportsImageInput"
>;

export type ProviderCatalogEntry = {
  id: ProviderName;
  name: string;
  models: ProviderCatalogModelEntry[];
  defaultModel: string;
};

export type ProviderCatalogPayload = {
  all: ProviderCatalogEntry[];
  default: Record<string, string>;
  connected: string[];
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  "aws-bedrock-proxy": "AWS Bedrock Proxy",
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  nvidia: "NVIDIA",
  "opencode-go": getOpenCodeDisplayName("opencode-go"),
  "opencode-zen": getOpenCodeDisplayName("opencode-zen"),
  "codex-cli": "Codex CLI",
};

export function listProviderCatalogEntries(): ProviderCatalogEntry[] {
  return PROVIDER_NAMES.map((provider) => ({
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: listSupportedModels(provider).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      knowledgeCutoff: model.knowledgeCutoff,
      supportsImageInput: model.supportsImageInput,
    })),
    defaultModel: defaultSupportedModel(provider).id,
  }));
}

export async function getProviderCatalog(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  readStore?: typeof readConnectionStore;
  readCodexAuthMaterialImpl?: typeof readCodexAuthMaterial;
  activeProvider?: ProviderName;
  activeModel?: string;
  awsBedrockProxyBaseUrl?: string;
  openaiProxyBaseUrl?: string;
} = {}): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAuthMaterialImpl = opts.readCodexAuthMaterialImpl ?? readCodexAuthMaterial;
  const store = await readStore(paths);
  const all = listProviderCatalogEntries();

  const awsBedrockProxyIndex = all.findIndex((entry) => entry.id === "aws-bedrock-proxy");
  if (awsBedrockProxyIndex >= 0) {
    const proxyEntry = all[awsBedrockProxyIndex];
    const savedKey = store.services["aws-bedrock-proxy"]?.mode === "api_key"
      ? store.services["aws-bedrock-proxy"].apiKey
      : undefined;
    const baseUrl = resolveAwsBedrockProxyBaseUrl({
      baseUrl: opts.awsBedrockProxyBaseUrl ?? opts.openaiProxyBaseUrl,
      env: {},
    });
    const discoveredModels = await discoverAwsBedrockProxyModels({
      baseUrl,
      apiKey: savedKey,
    });

    const mergedModels = discoveredModels.length > 0
      ? discoveredModels
      : proxyEntry.models;

    const activeProxyModel = opts.activeProvider === "aws-bedrock-proxy" ? opts.activeModel?.trim() : undefined;
    const hasActiveModel = Boolean(activeProxyModel && mergedModels.some((model) => model.id === activeProxyModel));
    const models = activeProxyModel && !hasActiveModel
      ? [
          {
            id: activeProxyModel,
            displayName: activeProxyModel,
            knowledgeCutoff: "Unknown",
            supportsImageInput: false,
          },
          ...mergedModels,
        ]
      : mergedModels;

    all[awsBedrockProxyIndex] = {
      ...proxyEntry,
      models,
      defaultModel: models[0]?.id ?? proxyEntry.defaultModel,
    };
  }

  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const hasCodexOauth = Boolean((await readCodexAuthMaterialImpl(paths))?.accessToken);
  const connected = PROVIDER_NAMES.filter((provider) => {
    const entry = store.services[provider];
    if (entry?.mode === "api_key" || entry?.mode === "oauth") return true;
    return provider === "codex-cli" && hasCodexOauth;
  });
  return { all, default: defaults, connected };
}
