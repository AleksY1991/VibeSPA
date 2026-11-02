import type { RunningApplication } from './startApplication';

export interface ApplicationGeneration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

interface ApplicationGenerationOptions {
  readonly previous?: ApplicationGeneration;
  mountInspector(): () => void;
  startApplication(): RunningApplication;
  disposeSystem(): Promise<void>;
  showStartupError(): () => void;
}

/** Serialize HMR generations while retaining diagnostics if shutdown fails. */
export function startApplicationGeneration(options: ApplicationGenerationOptions): ApplicationGeneration {
  const previousDisposal = options.previous?.dispose() ?? Promise.resolve();
  let application: RunningApplication | undefined;
  let unmountInspector: (() => void) | undefined;
  let unmountError: (() => void) | undefined;
  let entered = false;
  let startupSettled = false;
  let stopped = false;
  let systemDisposal: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;

  function disposeSystem(): Promise<void> {
    systemDisposal ??= (async () => { await options.disposeSystem(); })();
    return systemDisposal;
  }

  const ready = (async () => {
    // A rejected predecessor keeps its inspector and prevents reopening storage.
    await previousDisposal;
    if (stopped) return;
    entered = true;
    try {
      unmountInspector = options.mountInspector();
      application = options.startApplication();
      await application.ready;
    } catch (error) {
      if (!stopped) unmountError = options.showStartupError();
      throw error;
    } finally {
      startupSettled = true;
    }
  })();

  return {
    ready,
    dispose() {
      stopped = true;
      disposal ??= (async () => {
        await previousDisposal;
        if (!entered) return;

        // Mark the renderer stopped before canceling a constructor that may be
        // awaiting the system signal. Late acquisition must never mount a view.
        const errors: unknown[] = [];
        const applicationDisposal = (async () => { await application?.dispose(); })()
          .catch((error: unknown) => { errors.push(error); });
        if (!startupSettled) void disposeSystem().catch(() => {});
        await ready.catch(() => {});

        await applicationDisposal;
        try { await disposeSystem(); }
        catch (error) { if (!errors.includes(error)) errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Application generation cleanup failed.');

        // These roots belong to the generation, not the app scope: failed
        // cleanup must leave the last live snapshot available for inspection.
        unmountError?.();
        unmountInspector?.();
      })();
      return disposal;
    },
  };
}
