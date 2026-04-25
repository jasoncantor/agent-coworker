import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { QuickChatShell } = await import("../src/ui/quickChat/QuickChatShell");

describe("quick chat shell", () => {
  test("renders the popup surface edge-to-edge without its own outer rounded corner", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(QuickChatShell, {
          init: async () => {},
          ready: false,
          startupError: null,
        }));
      });

      const surface = container.querySelector(".app-surface-overlay");
      expect(surface).toBeInstanceOf(harness.dom.window.HTMLElement);
      expect(surface?.className).toContain("[contain:paint]");
      expect(surface?.className).not.toContain("rounded-[22px]");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
