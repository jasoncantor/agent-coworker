import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureControlSessionReady,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

export function createProviderActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "connectProvider" | "setProviderApiKey" | "copyProviderApiKey" | "authorizeProviderAuth" | "logoutProviderAuth" | "callbackProviderAuth" | "requestProviderCatalog" | "requestProviderAuthMethods" | "refreshProviderStatus" | "requestUserConfig" | "setGlobalOpenAiProxyBaseUrl"> {
  const currentWorkspaceId = () => get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;

  const withWorkspaceBootstrapError = (workspaceId: string, detail: string): string => {
    const runtimeError = get().workspaceRuntimeById[workspaceId]?.error?.trim();
    if (!runtimeError) return detail;
    return `${detail} Workspace server failed to start: ${runtimeError}`;
  };

  const notifyControlUnavailable = (workspaceId: string, detail: string) => {
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "Not connected",
        detail: withWorkspaceBootstrapError(workspaceId, detail),
      }),
    }));
  };

  const ensureReadyControlSession = async (workspaceId: string, detail: string): Promise<boolean> => {
    const ready = await ensureControlSessionReady(get, set, workspaceId);
    if (ready) return true;
    notifyControlUnavailable(workspaceId, detail);
    return false;
  };

  return {
    connectProvider: async (provider, apiKey) => {
      const methods = providerAuthMethodsFor(get(), provider);
      const normalizedKey = (apiKey ?? "").trim();
  
      if (normalizedKey) {
        const apiMethod = methods.find((method) => method.type === "api") ?? { id: "api_key", type: "api", label: "API key" };
        await get().setProviderApiKey(provider, apiMethod.id, normalizedKey);
        return;
      }
  
      const oauthMethod = methods.find((method) => method.type === "oauth");
      if (oauthMethod) {
        set(() => ({
          providerLastAuthChallenge: null,
          providerLastAuthResult: null,
        }));
        await get().authorizeProviderAuth(provider, oauthMethod.id);
        if (oauthMethod.oauthMode !== "code") {
          await get().callbackProviderAuth(provider, oauthMethod.id);
        }
        return;
      }
  
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "API key required",
          detail: `Enter an API key to connect ${provider}.`,
        }),
      }));
    },
  

    setProviderApiKey: async (provider, methodId, apiKey) => {
      const workspaceId = currentWorkspaceId();
      set({ pendingProviderAuthSave: null });
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      const trimmedKey = apiKey.trim();
      if (!trimmedKey) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing API key",
            detail: "Enter an API key before saving.",
          }),
        }));
        return;
      }
      if (!(await ensureReadyControlSession(workspaceId, "Unable to connect to provider auth service."))) {
        return;
      }
      const normalizedMethodId = methodId.trim() || "api_key";
      set(() => ({
        providerLastAuthResult: null,
        pendingProviderAuthSave: { provider, methodId: normalizedMethodId },
      }));

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_set_api_key",
        sessionId,
        provider,
        methodId: normalizedMethodId,
        apiKey: trimmedKey,
      }));
      if (!ok) {
        const detail = withWorkspaceBootstrapError(workspaceId, "Unable to send provider_auth_set_api_key.");
        set((s) => ({
          pendingProviderAuthSave: null,
          providerLastAuthResult: {
            type: "provider_auth_result",
            sessionId: s.workspaceRuntimeById[workspaceId]?.controlSessionId ?? "local",
            provider,
            methodId: normalizedMethodId,
            ok: false,
            message: detail,
          },
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail }),
        }));
      }
    },

    copyProviderApiKey: async (provider, sourceProvider) => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
      if (!(await ensureReadyControlSession(workspaceId, "Unable to connect to provider auth service."))) {
        return;
      }

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_copy_api_key",
        sessionId,
        provider,
        sourceProvider,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_copy_api_key.",
          }),
        }));
      }
    },
  

    authorizeProviderAuth: async (provider, methodId) => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
      if (!(await ensureReadyControlSession(workspaceId, "Unable to connect to provider auth service."))) {
        return;
      }
  
      const normalizedMethodId = methodId.trim();
      if (!normalizedMethodId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing auth method",
            detail: "Choose an auth method before continuing.",
          }),
        }));
        return;
      }

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_authorize",
        sessionId,
        provider,
        methodId: normalizedMethodId,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_authorize.",
          }),
        }));
      }
    },

    logoutProviderAuth: async (provider) => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
      if (!(await ensureReadyControlSession(workspaceId, "Unable to connect to provider auth service."))) {
        return;
      }

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_logout",
        sessionId,
        provider,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_logout.",
          }),
        }));
      }
    },
  

    callbackProviderAuth: async (provider, methodId, code) => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
      if (!(await ensureReadyControlSession(workspaceId, "Unable to connect to provider auth service."))) {
        return;
      }
  
      const normalizedMethodId = methodId.trim();
      if (!normalizedMethodId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing auth method",
            detail: "Choose an auth method before continuing.",
          }),
        }));
        return;
      }

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));
  
      const normalizedCode = code?.trim();
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_callback",
        sessionId,
        provider,
        methodId: normalizedMethodId,
        code: normalizedCode || undefined,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_callback.",
          }),
        }));
      }
    },
  

    requestProviderCatalog: async () => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) return;
      if (!(await ensureReadyControlSession(workspaceId, "Unable to request provider catalog."))) {
        return;
      }
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_catalog_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request provider catalog.",
          }),
        }));
      }
    },
  

    requestProviderAuthMethods: async () => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) return;
      if (!(await ensureReadyControlSession(workspaceId, "Unable to request provider auth methods."))) {
        return;
      }
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_auth_methods_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request provider auth methods.",
          }),
        }));
      }
    },

    requestUserConfig: async () => {
      const workspaceId = currentWorkspaceId();
      if (!workspaceId) return;
      if (!(await ensureReadyControlSession(workspaceId, "Unable to request global user config."))) {
        return;
      }

      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "user_config_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request global user config.",
          }),
        }));
      }
    },

    setGlobalOpenAiProxyBaseUrl: async (baseUrl) => {
      const workspaceId = currentWorkspaceId();
      set({ pendingUserConfigSave: false });
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
      if (!(await ensureReadyControlSession(workspaceId, "Unable to connect to global config service."))) {
        return;
      }

      const normalizedBaseUrl = typeof baseUrl === "string" ? baseUrl.trim() : null;
      set({ userConfigLastResult: null, pendingUserConfigSave: true });
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "user_config_set",
        sessionId,
        config: {
          awsBedrockProxyBaseUrl: normalizedBaseUrl && normalizedBaseUrl.length > 0 ? normalizedBaseUrl : null,
        },
      }));
      if (!ok) {
        const detail = withWorkspaceBootstrapError(workspaceId, "Unable to update global user config.");
        set((s) => ({
          pendingUserConfigSave: false,
          userConfigLastResult: {
            type: "user_config_result",
            sessionId: s.workspaceRuntimeById[workspaceId]?.controlSessionId ?? "local",
            ok: false,
            message: detail,
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail,
          }),
        }));
      }
    },
  

    refreshProviderStatus: async () => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      set({ providerStatusRefreshing: true });
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      const sock = RUNTIME.controlSockets.get(workspaceId);
      if (!sid || !sock) {
        set({ providerStatusRefreshing: false });
        return;
      }
  
      try {
        sock.send({ type: "refresh_provider_status", sessionId: sid });
        sock.send({ type: "provider_catalog_get", sessionId: sid });
        sock.send({ type: "provider_auth_methods_get", sessionId: sid });
      } catch {
        set((s) => ({
          providerStatusRefreshing: false,
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to refresh provider status." }),
        }));
      }
    },
  
  };
}
