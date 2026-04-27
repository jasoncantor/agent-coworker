import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  pushNotification,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";

export function createOpenAiNativeConnectorActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "requestOpenAiNativeConnectors"
  | "refreshOpenAiNativeConnectors"
  | "setOpenAiNativeConnectorEnabled"
> {
  async function requestConnectors(
    workspaceId: string,
    method: "cowork/connectors/openai-native/list" | "cowork/connectors/openai-native/refresh",
  ) {
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
    const cwd = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          openAiNativeConnectorsLoading: true,
          openAiNativeConnectorsError: null,
        },
      },
    }));
    const errorDetail: { message?: string } = {};
    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      method,
      { cwd },
      errorDetail,
    );
    if (ok) return;
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          openAiNativeConnectorsLoading: false,
          openAiNativeConnectorsError: errorDetail.message ?? "Unable to load OpenAI connectors.",
        },
      },
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "OpenAI connectors unavailable",
        detail: errorDetail.message ?? "Unable to load OpenAI native connectors.",
      }),
    }));
  }

  return {
    requestOpenAiNativeConnectors: async (workspaceId) => {
      await requestConnectors(workspaceId, "cowork/connectors/openai-native/list");
    },

    refreshOpenAiNativeConnectors: async (workspaceId) => {
      await requestConnectors(workspaceId, "cowork/connectors/openai-native/refresh");
    },

    setOpenAiNativeConnectorEnabled: async (workspaceId, connectorId, enabled) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const cwd = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      const errorDetail: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/connectors/openai-native/setEnabled",
        { cwd, connectorId, enabled },
        errorDetail,
      );
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Connector setting failed",
          detail: errorDetail.message ?? `Unable to update ${connectorId}.`,
        }),
      }));
    },
  };
}
