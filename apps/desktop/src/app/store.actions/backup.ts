import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  pushNotification,
  sendControl,
} from "../store.helpers";

function workspaceBackupActionKey(kind: string, targetSessionId: string, checkpointId?: string): string {
  return checkpointId ? `${kind}:${targetSessionId}:${checkpointId}` : `${kind}:${targetSessionId}`;
}

function setWorkspaceBackupsLoading(
  set: StoreSet,
  workspaceId: string,
  loading: boolean,
  error: string | null = null,
) {
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        workspaceBackupsLoading: loading,
        workspaceBackupsError: error,
      },
    },
  }));
}

function addWorkspaceBackupPendingAction(set: StoreSet, workspaceId: string, actionKey: string) {
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        workspaceBackupPendingActionKeys: {
          ...s.workspaceRuntimeById[workspaceId].workspaceBackupPendingActionKeys,
          [actionKey]: true,
        },
      },
    },
  }));
}

function clearWorkspaceBackupPendingAction(set: StoreSet, workspaceId: string, actionKey: string) {
  set((s) => {
    const current = { ...s.workspaceRuntimeById[workspaceId].workspaceBackupPendingActionKeys };
    delete current[actionKey];
    return {
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          workspaceBackupPendingActionKeys: current,
        },
      },
    };
  });
}

export function createWorkspaceBackupActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "requestWorkspaceBackupDelta"
  | "requestWorkspaceBackups"
  | "createWorkspaceBackupCheckpoint"
  | "restoreWorkspaceBackupOriginal"
  | "restoreWorkspaceBackupCheckpoint"
  | "deleteWorkspaceBackupCheckpoint"
> {
  async function ensureWorkspaceControl(workspaceId: string): Promise<boolean> {
    ensureWorkspaceRuntime(get, set, workspaceId);
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
    return true;
  }

  function notifyNotConnected(detail: string) {
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "Not connected",
        detail,
      }),
    }));
  }

  return {
    requestWorkspaceBackups: async (workspaceId: string) => {
      await ensureWorkspaceControl(workspaceId);
      setWorkspaceBackupsLoading(set, workspaceId, true, null);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "workspace_backups_get",
        sessionId,
      }));
      if (ok) return;

      setWorkspaceBackupsLoading(set, workspaceId, false, "Unable to request workspace backups.");
      notifyNotConnected("Unable to request workspace backups.");
    },

    requestWorkspaceBackupDelta: async (workspaceId: string, targetSessionId: string, checkpointId: string) => {
      await ensureWorkspaceControl(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            workspaceBackupDeltaLoading: true,
            workspaceBackupDeltaError: null,
          },
        },
      }));

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "workspace_backup_delta_get",
        sessionId,
        targetSessionId,
        checkpointId,
      }));
      if (ok) return;

      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            workspaceBackupDeltaLoading: false,
            workspaceBackupDeltaError: "Unable to inspect workspace backup delta.",
          },
        },
      }));
      notifyNotConnected("Unable to inspect the selected workspace checkpoint.");
    },

    createWorkspaceBackupCheckpoint: async (workspaceId: string, targetSessionId: string) => {
      await ensureWorkspaceControl(workspaceId);
      const actionKey = workspaceBackupActionKey("checkpoint", targetSessionId);
      addWorkspaceBackupPendingAction(set, workspaceId, actionKey);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "workspace_backup_checkpoint",
        sessionId,
        targetSessionId,
      }));
      if (ok) return;

      clearWorkspaceBackupPendingAction(set, workspaceId, actionKey);
      notifyNotConnected("Unable to create a workspace checkpoint.");
    },

    restoreWorkspaceBackupOriginal: async (workspaceId: string, targetSessionId: string) => {
      await ensureWorkspaceControl(workspaceId);
      const actionKey = workspaceBackupActionKey("restore-original", targetSessionId);
      addWorkspaceBackupPendingAction(set, workspaceId, actionKey);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "workspace_backup_restore",
        sessionId,
        targetSessionId,
      }));
      if (ok) return;

      clearWorkspaceBackupPendingAction(set, workspaceId, actionKey);
      notifyNotConnected("Unable to restore the original workspace snapshot.");
    },

    restoreWorkspaceBackupCheckpoint: async (workspaceId: string, targetSessionId: string, checkpointId: string) => {
      await ensureWorkspaceControl(workspaceId);
      const actionKey = workspaceBackupActionKey("restore-checkpoint", targetSessionId, checkpointId);
      addWorkspaceBackupPendingAction(set, workspaceId, actionKey);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "workspace_backup_restore",
        sessionId,
        targetSessionId,
        checkpointId,
      }));
      if (ok) return;

      clearWorkspaceBackupPendingAction(set, workspaceId, actionKey);
      notifyNotConnected("Unable to restore the selected checkpoint.");
    },

    deleteWorkspaceBackupCheckpoint: async (workspaceId: string, targetSessionId: string, checkpointId: string) => {
      await ensureWorkspaceControl(workspaceId);
      const actionKey = workspaceBackupActionKey("delete-checkpoint", targetSessionId, checkpointId);
      addWorkspaceBackupPendingAction(set, workspaceId, actionKey);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "workspace_backup_delete_checkpoint",
        sessionId,
        targetSessionId,
        checkpointId,
      }));
      if (ok) return;

      clearWorkspaceBackupPendingAction(set, workspaceId, actionKey);
      notifyNotConnected("Unable to delete the selected checkpoint.");
    },
  };
}
