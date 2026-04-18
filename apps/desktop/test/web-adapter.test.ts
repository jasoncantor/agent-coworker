import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();

const localStorageMock = {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalInjectedServerUrlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__COWORK_SERVER_URL__");

function installWindowMock() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        host: "localhost:8281",
      },
      localStorage: localStorageMock,
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "__COWORK_SERVER_URL__", {
    configurable: true,
    writable: true,
    value: "ws://127.0.0.1:7337/ws",
  });
}

function restoreWindowMock() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }

  if (originalInjectedServerUrlDescriptor) {
    Object.defineProperty(globalThis, "__COWORK_SERVER_URL__", originalInjectedServerUrlDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).__COWORK_SERVER_URL__;
  }
}

installWindowMock();

const { deriveSameOriginServerUrl, normalizeWebServerUrl } = await import("../src/lib/webAdapter");

describe("webAdapter server URL normalization", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("derives the live Cowork websocket URL injected by the web dev shell", () => {
    expect(deriveSameOriginServerUrl()).toBe("ws://127.0.0.1:7337/ws");
  });

  test("normalizes legacy same-origin websocket URLs onto the injected Cowork server URL", () => {
    expect(normalizeWebServerUrl("ws://localhost:8281/ws")).toBe("ws://127.0.0.1:7337/ws");
  });

  test("leaves direct Cowork server websocket URLs unchanged", () => {
    expect(normalizeWebServerUrl("ws://127.0.0.1:7337/ws")).toBe("ws://127.0.0.1:7337/ws");
  });
});

afterAll(() => {
  restoreWindowMock();
});
