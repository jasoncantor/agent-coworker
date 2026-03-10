import { describe, expect, test } from "bun:test";

import {
  getVisibleSidebarThreads,
  reorderSidebarItemsById,
  shouldEmphasizeWorkspaceRow,
} from "../src/ui/sidebarHelpers";

describe("desktop sidebar helpers", () => {
  test("caps visible threads at 10 by default and reports hidden overflow", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}` }));

    expect(getVisibleSidebarThreads(threads, false)).toEqual({
      visibleThreads: threads.slice(0, 10),
      hiddenThreadCount: 2,
    });
  });

  test("returns all threads when the overflow list is expanded", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}` }));

    expect(getVisibleSidebarThreads(threads, true)).toEqual({
      visibleThreads: threads,
      hiddenThreadCount: 0,
    });
  });

  test("reorders workspaces without re-sorting by recency", () => {
    const workspaces = [
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ];

    expect(reorderSidebarItemsById(workspaces, "ws-3", "ws-1")).toEqual([
      { id: "ws-3", name: "deep-research-knowledgebase" },
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
    ]);
  });

  test("does not emphasize the workspace row when one of its threads is selected", () => {
    expect(shouldEmphasizeWorkspaceRow(true, "thread-2", ["thread-1", "thread-2"])).toBe(false);
    expect(shouldEmphasizeWorkspaceRow(true, null, ["thread-1", "thread-2"])).toBe(true);
    expect(shouldEmphasizeWorkspaceRow(true, "thread-9", ["thread-1", "thread-2"])).toBe(true);
    expect(shouldEmphasizeWorkspaceRow(false, "thread-2", ["thread-1", "thread-2"])).toBe(false);
  });
});
