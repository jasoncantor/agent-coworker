export type RemodexQrPairingPayload = {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  pairingSecret: string;
  expiresAt: number;
};

export type RemodexTrustedMacSummary = {
  macDeviceId: string;
  macIdentityPublicKey: string;
  relay: string;
  displayName: string | null;
  lastResolvedAt: string | null;
};

export type RemodexSecureTransportState = {
  status: "idle" | "pairing" | "connecting" | "connected" | "reconnecting" | "error";
  transportMode: "native" | "fallback" | "unsupported";
  connectedMacDeviceId: string | null;
  relay: string | null;
  sessionId: string | null;
  trustedMacs: RemodexTrustedMacSummary[];
  lastError: string | null;
};

export type RemodexSecureTransportEvents = {
  stateChanged: (state: RemodexSecureTransportState) => void;
  plaintextMessage: (event: { text: string }) => void;
  secureError: (event: { message: string }) => void;
  socketClosed: (event: { code?: number; reason?: string | null }) => void;
};

export type NativeSecureTransportModule = {
  listTrustedMacs(): Promise<RemodexTrustedMacSummary[]>;
  forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState>;
  connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState>;
  connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState>;
  disconnect(): Promise<RemodexSecureTransportState>;
  sendPlaintext(text: string): Promise<void>;
  getState(): Promise<RemodexSecureTransportState>;
  addListener<EventName extends keyof RemodexSecureTransportEvents>(
    eventName: EventName,
    listener: RemodexSecureTransportEvents[EventName],
  ): { remove(): void };
  removeAllListeners(eventName: keyof RemodexSecureTransportEvents): void;
};

export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync?(key: string): Promise<void>;
};

export type PersistedPhoneIdentity = {
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  phoneIdentityPrivateKey: string;
};

export type PersistedTrustedMacRecord = RemodexTrustedMacSummary & {
  lastSessionId: string | null;
  lastOutboundCounter: number;
  lastInboundCounter: number;
};

export type PersistedRelayTransportState = {
  phoneIdentity: PersistedPhoneIdentity | null;
  trustedMacs: PersistedTrustedMacRecord[];
};

export type RuntimeWebSocket = {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: ((event: { code?: number; reason?: string | null }) => void) | null;
};

export type MockFeedItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      ts: string;
      text: string;
    }
  | {
      id: string;
      kind: "system";
      ts: string;
      line: string;
    };

export type MockThreadRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
  feed: MockFeedItem[];
};

export type PendingServerRequestRecord =
  | {
      kind: "approval";
      requestId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      prompt: string;
      command: string;
      dangerous: boolean;
      reason: string;
    }
  | {
      kind: "ask";
      requestId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      prompt: string;
      question: string;
      options?: string[];
    };
