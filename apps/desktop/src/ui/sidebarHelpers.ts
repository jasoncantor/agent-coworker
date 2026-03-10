const MAX_VISIBLE_THREADS = 10;

export function formatSidebarRelativeAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (elapsedMs < minute) return "now";
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m`;
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h`;
  if (elapsedMs < week) return `${Math.floor(elapsedMs / day)}d`;
  if (elapsedMs < month) return `${Math.floor(elapsedMs / week)}w`;
  if (elapsedMs < year) return `${Math.floor(elapsedMs / month)}mo`;
  return `${Math.floor(elapsedMs / year)}y`;
}

export function getVisibleSidebarThreads<T>(threads: T[], showAll: boolean, limit = MAX_VISIBLE_THREADS): {
  visibleThreads: T[];
  hiddenThreadCount: number;
} {
  const visibleThreads = showAll ? threads : threads.slice(0, limit);
  return {
    visibleThreads,
    hiddenThreadCount: Math.max(0, threads.length - visibleThreads.length),
  };
}

export function reorderSidebarItemsById<T extends { id: string }>(
  items: T[],
  sourceId: string,
  targetId: string,
): T[] {
  if (sourceId === targetId) {
    return items;
  }

  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);

  if (sourceIndex === -1 || targetIndex === -1) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(sourceIndex, 1);
  nextItems.splice(targetIndex, 0, movedItem);
  return nextItems;
}

export function shouldEmphasizeWorkspaceRow(
  isSelectedWorkspace: boolean,
  selectedThreadId: string | null,
  workspaceThreadIds: string[],
): boolean {
  if (!isSelectedWorkspace) {
    return false;
  }

  if (!selectedThreadId) {
    return true;
  }

  return !workspaceThreadIds.includes(selectedThreadId);
}
