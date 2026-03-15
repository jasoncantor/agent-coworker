export type IosRelayPeer = {
  id: string;
  name: string;
  state: "disconnected" | "connecting" | "connected";
};

export type IosRelayDiscoveredPeer = {
  id: string;
  name: string;
  deviceId: string;
};

export type IosRelayLogEntry = {
  id: string;
  at: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type IosRelayState = {
  supported: boolean;
  advertising: boolean;
  peer: IosRelayPeer | null;
  localDeviceId?: string | null;
  localDeviceName?: string | null;
  discoveredPeers?: IosRelayDiscoveredPeer[];
  publishedWorkspaceId: string | null;
  publishedWorkspaceName?: string | null;
  openChannelCount: number;
  lastError: string | null;
  diagnosticLogs?: IosRelayLogEntry[];
};

export type IosRelayConfig = {
  rememberedPeerId: string | null;
  rememberedPeerName: string | null;
  deviceName: string | null;
};

export function createDefaultIosRelayState(supported = false): IosRelayState {
  return {
    supported,
    advertising: false,
    peer: null,
    localDeviceId: null,
    localDeviceName: null,
    discoveredPeers: [],
    publishedWorkspaceId: null,
    publishedWorkspaceName: null,
    openChannelCount: 0,
    lastError: supported ? null : "iOS Relay is only available on macOS desktop builds.",
    diagnosticLogs: [],
  };
}

export function createDefaultIosRelayConfig(): IosRelayConfig {
  return {
    rememberedPeerId: null,
    rememberedPeerName: null,
    deviceName: null,
  };
}
