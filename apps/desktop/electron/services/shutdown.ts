type QuitEvent = {
  preventDefault(): void;
};

type ShutdownDeps = {
  unregisterIpc: () => void;
  unregisterAppearanceListener?: () => void;
  stopUpdater?: () => void;
  stopAllServers: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
};

export function createBeforeQuitHandler(deps: ShutdownDeps): (event: QuitEvent) => void {
  let shutdownStarted = false;
  let shutdownFinished = false;

  return (event: QuitEvent) => {
    if (shutdownFinished) {
      return;
    }

    if (shutdownStarted) {
      event.preventDefault();
      return;
    }

    shutdownStarted = true;
    event.preventDefault();

    void deps
      .stopAllServers()
      .catch((error) => {
        deps.onError?.(error);
      })
      .finally(() => {
        deps.unregisterIpc();
        deps.unregisterAppearanceListener?.();
        deps.stopUpdater?.();
        shutdownFinished = true;
        deps.quit();
      });
  };
}
