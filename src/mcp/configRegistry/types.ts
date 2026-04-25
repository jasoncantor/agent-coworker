import type { MCPServerConfig, PluginScope } from "../../types";

export type MCPServerSource =
  | "workspace"
  | "user"
  | "system"
  | "plugin";

export interface MCPRegistryServer extends MCPServerConfig {
  source: MCPServerSource;
  inherited: boolean;
  pluginId?: string;
  pluginName?: string;
  pluginDisplayName?: string;
  pluginScope?: PluginScope;
}

export interface MCPRegistryFileState {
  source: MCPServerSource;
  path: string;
  exists: boolean;
  editable: boolean;
  legacy: boolean;
  pluginId?: string;
  pluginName?: string;
  pluginDisplayName?: string;
  pluginScope?: PluginScope;
  parseError?: string;
  serverCount: number;
}

export interface MCPConfigRegistrySnapshot {
  servers: MCPRegistryServer[];
  files: MCPRegistryFileState[];
  warnings: string[];
}
