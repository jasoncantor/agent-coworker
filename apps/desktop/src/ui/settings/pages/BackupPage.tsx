import { useEffect, useEffectEvent, useState } from "react";

import {
  AlertTriangleIcon,
  ArchiveIcon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderOpenIcon,
  HardDriveIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";

import { useAppStore } from "../../../app/store";
import type {
  WorkspaceBackupDeltaEvent,
  WorkspaceBackupEntry,
  WorkspaceRecord,
  WorkspaceRuntime,
} from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { confirmAction, revealPath } from "../../../lib/desktopCommands";
import { cn } from "../../../lib/utils";

type BackupPageProps = {
  workspace?: WorkspaceRecord | null;
  runtime?: WorkspaceRuntime | null;
  onRefresh?: () => Promise<void> | void;
  onCreateCheckpoint?: (targetSessionId: string) => Promise<void> | void;
  onRestoreOriginal?: (targetSessionId: string) => Promise<void> | void;
  onRestoreCheckpoint?: (targetSessionId: string, checkpointId: string) => Promise<void> | void;
  onDeleteCheckpoint?: (targetSessionId: string, checkpointId: string) => Promise<void> | void;
  onRevealFolder?: (path: string) => Promise<void> | void;
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0 B";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function pendingActionKey(kind: string, targetSessionId: string, checkpointId?: string): string {
  return checkpointId ? `${kind}:${targetSessionId}:${checkpointId}` : `${kind}:${targetSessionId}`;
}

function backupTitle(entry: WorkspaceBackupEntry): string {
  if (entry.title?.trim()) return entry.title;
  if (entry.lifecycle === "deleted") return "Deleted session";
  return entry.targetSessionId;
}

function sortByUpdated(entries: WorkspaceBackupEntry[]): WorkspaceBackupEntry[] {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: any }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-border/70 bg-background/70 p-5">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted/65 text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
      </div>
    </div>
  );
}

export function BackupPage(props: BackupPageProps = {}) {
  const selectedWorkspaceIdFromStore = useAppStore((s) => s.selectedWorkspaceId);
  const workspacesFromStore = useAppStore((s) => s.workspaces);
  const runtimeByIdFromStore = useAppStore((s) => s.workspaceRuntimeById);
  const selectWorkspaceFromStore = useAppStore((s) => s.selectWorkspace);
  const requestWorkspaceBackupsFromStore = useAppStore((s) => s.requestWorkspaceBackups);
  const requestWorkspaceBackupDeltaFromStore = useAppStore((s) => s.requestWorkspaceBackupDelta);
  const createWorkspaceBackupCheckpointFromStore = useAppStore((s) => s.createWorkspaceBackupCheckpoint);
  const restoreWorkspaceBackupOriginalFromStore = useAppStore((s) => s.restoreWorkspaceBackupOriginal);
  const restoreWorkspaceBackupCheckpointFromStore = useAppStore((s) => s.restoreWorkspaceBackupCheckpoint);
  const deleteWorkspaceBackupCheckpointFromStore = useAppStore((s) => s.deleteWorkspaceBackupCheckpoint);
  const serverState = typeof window === "undefined" ? useAppStore.getState() : null;

  const selectedWorkspaceId = serverState?.selectedWorkspaceId ?? selectedWorkspaceIdFromStore;
  const workspaces = serverState?.workspaces ?? workspacesFromStore;
  const workspaceRuntimeById = serverState?.workspaceRuntimeById ?? runtimeByIdFromStore;

  const workspaceList = props.workspace !== undefined ? (props.workspace ? [props.workspace] : []) : workspaces;
  const workspace = props.workspace !== undefined
    ? props.workspace
    : (selectedWorkspaceId
      ? workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null
      : workspaces[0] ?? null);
  const runtime = props.runtime !== undefined ? props.runtime : (workspace ? workspaceRuntimeById[workspace.id] ?? null : null);

  const refreshBackups = props.onRefresh
    ?? (workspace ? () => requestWorkspaceBackupsFromStore(workspace.id) : undefined);
  const createCheckpoint = props.onCreateCheckpoint
    ?? (workspace ? (targetSessionId: string) => createWorkspaceBackupCheckpointFromStore(workspace.id, targetSessionId) : undefined);
  const restoreOriginal = props.onRestoreOriginal
    ?? (workspace ? (targetSessionId: string) => restoreWorkspaceBackupOriginalFromStore(workspace.id, targetSessionId) : undefined);
  const restoreCheckpoint = props.onRestoreCheckpoint
    ?? (workspace ? (targetSessionId: string, checkpointId: string) => restoreWorkspaceBackupCheckpointFromStore(workspace.id, targetSessionId, checkpointId) : undefined);
  const deleteCheckpoint = props.onDeleteCheckpoint
    ?? (workspace ? (targetSessionId: string, checkpointId: string) => deleteWorkspaceBackupCheckpointFromStore(workspace.id, targetSessionId, checkpointId) : undefined);
  const revealFolder = props.onRevealFolder ?? (async (folderPath: string) => await revealPath({ path: folderPath }));
  
  const [selectedTargetSessionId, setSelectedTargetSessionId] = useState<string | null>(null);
  // null means the backup itself is selected, a string means a specific checkpoint is selected
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);

  const runInitialRefresh = useEffectEvent(() => {
    if (!workspace) return;
    if (props.onRefresh) {
      void props.onRefresh();
      return;
    }
    void requestWorkspaceBackupsFromStore(workspace.id);
  });

  useEffect(() => {
    if (!workspace?.id || !runtime?.controlSessionId) return;
    runInitialRefresh();
  }, [workspace?.id, runtime?.controlSessionId]);

  const entries = runtime?.workspaceBackups ?? [];
  const sortedEntries = sortByUpdated(entries);
  const activeTargetSessionId = selectedTargetSessionId ?? sortedEntries[0]?.targetSessionId ?? null;

  useEffect(() => {
    const selectedEntry = activeTargetSessionId
      ? sortedEntries.find((entry) => entry.targetSessionId === activeTargetSessionId) ?? null
      : null;
    
    if (selectedEntry && selectedCheckpointId) {
      const checkpointStillExists = selectedEntry.checkpoints.some((cp) => cp.id === selectedCheckpointId);
      if (!checkpointStillExists) setSelectedCheckpointId(null);
    }
  }, [sortedEntries, activeTargetSessionId, selectedCheckpointId]);

  const requestSelectedDelta = useEffectEvent(() => {
    if (!workspace?.id || !selectedTargetSessionId || !selectedCheckpointId) return;
    void requestWorkspaceBackupDeltaFromStore(workspace.id, selectedTargetSessionId, selectedCheckpointId);
  });

  useEffect(() => {
    if (!workspace?.id || !runtime?.controlSessionId || !activeTargetSessionId || !selectedCheckpointId) return;
    requestSelectedDelta();
  }, [workspace?.id, runtime?.controlSessionId, activeTargetSessionId, selectedCheckpointId]);

  if (!workspace) {
    return (
      <div className="p-4 space-y-4">
        <h1 className="text-2xl font-semibold">Workspace Backups</h1>
        <div className="p-8 text-center text-muted-foreground border rounded-xl bg-card">
          Select a workspace first to manage its backup history.
        </div>
      </div>
    );
  }

  const pendingActions = runtime?.workspaceBackupPendingActionKeys ?? {};
  const loading = runtime?.workspaceBackupsLoading ?? false;
  const error = runtime?.workspaceBackupsError ?? null;
  const deltaPreview = runtime?.workspaceBackupDelta ?? null;
  const deltaError = runtime?.workspaceBackupDeltaError ?? null;
  const deltaLoading = runtime?.workspaceBackupDeltaLoading ?? false;

  const selectedEntry = sortedEntries.find((entry) => entry.targetSessionId === activeTargetSessionId);
  const selectedCp = selectedEntry?.checkpoints.find(c => c.id === selectedCheckpointId);
  const activeDelta = activeTargetSessionId && selectedCheckpointId && deltaPreview?.checkpointId === selectedCheckpointId ? deltaPreview : null;

  return (
    <div className="flex h-full min-h-0 flex-col space-y-5" data-backup-page="true">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-5 shrink-0">
        <div>
          <h1 className="text-[2rem] font-semibold tracking-tight text-foreground">Workspace Backups</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            File explorer for your backup history and restore points.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {workspaceList.length > 1 && props.workspace === undefined && (
            <Select value={workspace.id} onValueChange={(val) => { if (val !== workspace.id) void selectWorkspaceFromStore(val); }}>
              <SelectTrigger className="h-11 w-[220px] border-border/70 bg-background/70">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaceList.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2 shrink-0">
          <AlertTriangleIcon className="h-4 w-4"/>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden border border-border/50 bg-background/35">
        <div className="w-72 shrink-0 border-r border-border/50 bg-muted/20 sm:w-80">
          <div className="flex items-center justify-between border-b border-border/50 bg-muted/25 px-4 py-4 shrink-0">
            <span className="font-semibold text-sm text-foreground">Backup History</span>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => void refreshBackups?.()} disabled={loading}>
              <RefreshCwIcon className={cn("h-4 w-4 text-muted-foreground", loading ? "animate-spin" : "")} />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            {sortedEntries.length === 0 && !loading ? (
              <div className="text-sm text-muted-foreground text-center py-4">No backups found.</div>
            ) : null}
            
            {sortedEntries.map((entry) => {
              const isBackupSelected = entry.targetSessionId === selectedTargetSessionId && selectedCheckpointId === null;
              
              return (
                <div key={entry.targetSessionId} className="space-y-1">
                  <button
                    onClick={() => { setSelectedTargetSessionId(entry.targetSessionId); setSelectedCheckpointId(null); }}
                    className={cn(
                      "w-full text-left px-3 py-3 flex items-center gap-2.5 rounded-xl font-medium text-sm transition-colors",
                      isBackupSelected
                        ? "bg-background text-foreground shadow-sm ring-1 ring-primary/15"
                        : "hover:bg-background/70 text-foreground"
                    )}
                  >
                    <FolderOpenIcon className={cn("w-4 h-4 shrink-0", isBackupSelected ? "text-primary" : "text-muted-foreground")} />
                    <span className="truncate flex-1">{backupTitle(entry)}</span>
                    {entry.lifecycle === "active" ? (
                      <Badge variant="secondary" className="h-5 rounded-full border border-primary/10 bg-primary/10 px-2 text-[10px] text-primary">
                        active
                      </Badge>
                    ) : null}
                    {entry.status === "failed" && <AlertTriangleIcon className="w-3.5 h-3.5 text-destructive shrink-0" />}
                  </button>
                  
                  <div className="ml-[13px] border-l border-border/50 pl-3.5 space-y-1">
                    {entry.checkpoints.length === 0 ? (
                      <div className="py-1 text-xs italic text-muted-foreground/75">No checkpoints</div>
                    ) : (
                      [...entry.checkpoints].reverse().map((cp) => {
                        const isCpSelected = entry.targetSessionId === selectedTargetSessionId && selectedCheckpointId === cp.id;
                        return (
                           <button
                             key={cp.id}
                             onClick={() => { setSelectedTargetSessionId(entry.targetSessionId); setSelectedCheckpointId(cp.id); }}
                             className={cn(
                              "w-full text-left px-2.5 py-1.5 flex items-center justify-between rounded-lg text-sm transition-colors",
                              isCpSelected
                                ? "bg-background text-foreground shadow-sm ring-1 ring-primary/15"
                                : "hover:bg-background/60 text-muted-foreground"
                             )}
                           >
                             <div className="flex items-center gap-2 min-w-0">
                               <FileTextIcon className="w-3.5 h-3.5 shrink-0 opacity-70" />
                               <span className="font-mono text-xs truncate">{cp.id}</span>
                             </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex-1 min-w-0 bg-background/75">
          {!selectedEntry ? (
             <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center space-y-4">
                <ArchiveIcon className="h-12 w-12 opacity-20" />
                <p>Select a backup or checkpoint from the sidebar to inspect it.</p>
             </div>
          ) : selectedCheckpointId === null ? (
            /* BACKUP DETAILS VIEW */
            <div className="flex-1 flex flex-col overflow-y-auto">
              <div className="border-b border-border/50 bg-background px-8 py-7">
                <div className="flex items-start gap-4">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-3xl bg-muted/75 text-primary">
                    <FolderOpenIcon className="h-6 w-6" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-xl font-semibold truncate">{backupTitle(selectedEntry)}</h2>
                    <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1 flex-wrap">
                      <span>{selectedEntry.provider || "Unknown"} • {selectedEntry.model || "Unknown model"}</span>
                      <span>&bull;</span>
                       <Badge
                         variant={selectedEntry.lifecycle === "active" ? "secondary" : "secondary"}
                         className={cn(
                           "h-5 text-[10px]",
                           selectedEntry.lifecycle === "active" ? "border border-primary/10 bg-primary/10 text-primary" : ""
                         )}
                       >
                         {selectedEntry.lifecycle}
                       </Badge>
                      {selectedEntry.status === "failed" && (
                        <Badge variant="destructive" className="h-5 text-[10px]">Failed</Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    className="border-border/70 bg-background/80"
                    onClick={() => void createCheckpoint?.(selectedEntry.targetSessionId)}
                    disabled={selectedEntry.status !== "ready" || pendingActions[pendingActionKey("checkpoint", selectedEntry.targetSessionId)]}
                  >
                    <SaveIcon className="mr-2 h-4 w-4" />
                    Create Checkpoint
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      const confirmed = await confirmAction({
                        title: "Restore Original State",
                        message: "Restore the workspace to before this session started?",
                        detail: "This overwrites current files. We will create a safety checkpoint first just in case.",
                        kind: "warning",
                        confirmLabel: "Restore",
                        cancelLabel: "Cancel",
                        defaultAction: "cancel",
                      });
                      if (confirmed) await restoreOriginal?.(selectedEntry.targetSessionId);
                    }}
                    disabled={selectedEntry.status !== "ready" || pendingActions[pendingActionKey("restore-original", selectedEntry.targetSessionId)]}
                  >
                    <RotateCcwIcon className="mr-2 h-4 w-4" />
                    Restore Original Workspace
                  </Button>
                  {selectedEntry.backupDirectory && (
                    <Button variant="outline" className="border-border/70 bg-background/80" onClick={() => void revealFolder(selectedEntry.backupDirectory!)}>
                      <FolderOpenIcon className="mr-2 h-4 w-4" />
                      Reveal Folder
                    </Button>
                  )}
                </div>
              </div>

              {selectedEntry.failureReason && (
                <div className="mx-8 mt-6 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  <strong>Backup Error:</strong> {selectedEntry.failureReason}
                </div>
              )}

              <div className="grid grid-cols-1 gap-5 p-8 pt-6 md:grid-cols-2">
                 <StatCard label="Created At" value={formatTimestamp(selectedEntry.createdAt)} icon={ClockIcon} />
                 <StatCard label="Last Updated" value={formatTimestamp(selectedEntry.updatedAt)} icon={RefreshCwIcon} />
                 <StatCard label="Total Storage" value={formatBytes(selectedEntry.totalBytes)} icon={HardDriveIcon} />
                 <StatCard label="Checkpoints" value={String(selectedEntry.checkpoints.length)} icon={DatabaseIcon} />
              </div>
            </div>
          ) : selectedCp ? (
            /* CHECKPOINT FILE EXPLORER VIEW */
             <div className="flex-1 flex flex-col h-full overflow-hidden">
               <div className="flex h-16 items-center justify-between border-b border-border/50 bg-background px-6 shrink-0">
                 <div className="flex flex-col">
                   <div className="flex items-center gap-2">
                     <h2 className="font-semibold text-sm">Checkpoint <span className="font-mono ml-1 text-primary">{selectedCp.id}</span></h2>
                     {selectedCp.trigger !== "manual" && <Badge variant="outline" className="text-[9px] uppercase h-4 py-0">{selectedCp.trigger}</Badge>}
                   </div>
                   <div className="text-xs text-muted-foreground mt-0.5">Captured {formatTimestamp(selectedCp.createdAt)}</div>
                 </div>
                 <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                       variant="outline"
                       className="h-8"
                      onClick={async () => {
                        const confirmed = await confirmAction({
                          title: "Restore Checkpoint",
                          message: `Restore workspace to checkpoint ${selectedCp.id}?`,
                          kind: "warning",
                          confirmLabel: "Restore",
                          cancelLabel: "Cancel",
                          defaultAction: "cancel",
                        });
                        if (confirmed) await restoreCheckpoint?.(selectedEntry.targetSessionId, selectedCp.id);
                      }}
                      disabled={selectedEntry.status !== "ready" || pendingActions[pendingActionKey("restore-checkpoint", selectedEntry.targetSessionId, selectedCp.id)]}
                    >
                      <RotateCcwIcon className="mr-2 h-3.5 w-3.5" />
                      Restore
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        const confirmed = await confirmAction({
                          title: "Delete Checkpoint",
                          message: `Delete checkpoint ${selectedCp.id}?`,
                          kind: "warning",
                          confirmLabel: "Delete",
                          cancelLabel: "Cancel",
                          defaultAction: "cancel",
                        });
                        if (confirmed) await deleteCheckpoint?.(selectedEntry.targetSessionId, selectedCp.id);
                      }}
                      disabled={selectedEntry.status !== "ready" || pendingActions[pendingActionKey("delete-checkpoint", selectedEntry.targetSessionId, selectedCp.id)]}
                    >
                      <Trash2Icon className="h-4 w-4" />
                    </Button>
                 </div>
               </div>

               {/* File Delta List Area */}
               <div className="flex-1 flex flex-col overflow-hidden bg-background">
                  <div className="flex items-center justify-between border-b border-border/40 bg-muted/10 px-6 py-3 text-xs shrink-0">
                    <span className="text-muted-foreground flex items-center gap-1">
                       Compared to baseline: 
                       <span className="font-mono font-medium text-foreground bg-muted/40 px-1.5 py-0.5 rounded">{activeDelta?.baselineLabel || "..."}</span>
                    </span>
                    {activeDelta && (
                      <div className="flex items-center gap-4 font-medium">
                        <span className="text-emerald-600">+{activeDelta.counts.added}</span>
                        <span className="text-amber-600">~{activeDelta.counts.modified}</span>
                        <span className="text-destructive">-{activeDelta.counts.deleted}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto">
                    {deltaLoading && !activeDelta ? (
                       <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">Loading file changes...</div>
                    ) : deltaError ? (
                       <div className="m-5 p-4 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20">{deltaError}</div>
                    ) : activeDelta?.files.length === 0 ? (
                       <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                          <FileTextIcon className="h-8 w-8 mb-2 opacity-20" />
                          <div className="text-sm">No file changes detected in this checkpoint.</div>
                       </div>
                     ) : activeDelta ? (
                        <div className="min-w-[500px]">
                         <div className="sticky top-0 z-10 flex items-center border-b border-border/40 bg-background px-6 py-2 text-xs font-medium text-muted-foreground">
                             <div className="flex-1">Name</div>
                             <div className="w-24">Kind</div>
                             <div className="w-24 text-right">Status</div>
                          </div>
                          <div className="divide-y divide-border/30">
                            {activeDelta.files.map(f => (
                              <div key={f.path} className="group flex items-center px-6 py-2.5 text-sm transition-colors hover:bg-muted/30">
                                <div className="flex-1 flex items-center gap-3 min-w-0 pr-4">
                                 {f.kind === "directory" ? <FolderOpenIcon className="w-4 h-4 text-blue-400 shrink-0" /> : <FileTextIcon className="w-4 h-4 text-muted-foreground shrink-0" />}
                                 <span className="font-mono text-[13px] truncate" title={f.path}>{f.path}</span>
                               </div>
                               <div className="w-24 text-xs text-muted-foreground capitalize shrink-0">{f.kind}</div>
                               <div className="w-24 text-right shrink-0">
                                 <Badge variant="outline" className={cn(
                                   "text-[10px] uppercase h-5 py-0",
                                   f.change === "added" ? "text-emerald-600 border-emerald-600/30 bg-emerald-600/5 group-hover:bg-emerald-600/10" :
                                   f.change === "modified" ? "text-amber-600 border-amber-600/30 bg-amber-600/5 group-hover:bg-amber-600/10" :
                                   "text-destructive border-destructive/30 bg-destructive/5 group-hover:bg-destructive/10"
                                 )}>
                                   {f.change}
                                 </Badge>
                               </div>
                             </div>
                           ))}
                         </div>
                         {activeDelta.truncated && (
                           <div className="p-3 text-xs text-muted-foreground text-center border-t border-border/40 bg-muted/10">
                             List truncated. Showing partial file list, but counts reflect total changes.
                           </div>
                         )}
                       </div>
                    ) : null}
                  </div>
               </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
