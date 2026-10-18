interface DisposableApplication {
  dispose(): Promise<void>;
}

export interface RunningApplication {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

/** Own the application and renderer together, including failed or canceled boot. */
export function startApplication<Application extends DisposableApplication>(
  create: () => Promise<Application>,
  mount: (application: Application) => () => void | Promise<void>,
): RunningApplication {
  let application: Application | undefined;
  let unmount: (() => void | Promise<void>) | undefined;
  let stopped = false;
  let teardown: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;

  function cleanUp(): Promise<void> {
    teardown ??= (async () => {
      const errors: unknown[] = [];
      try { await unmount?.(); } catch (error) { errors.push(error); }
      try { await application?.dispose(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Renderer and application cleanup failed.');
    })();
    return teardown;
  }

  const ready = (async () => {
    try {
      application = await create();
      if (!stopped) unmount = mount(application);
    } catch (error) {
      try { await cleanUp(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Application startup and rollback failed.', { cause: cleanupError });
      }
      throw error;
    }
  })();

  return {
    ready,
    dispose() {
      stopped = true;
      // Waiting for acquisition closes resources even when HMR interrupts boot.
      // Failed boot already rolls back; its cleanup failure still propagates.
      disposal ??= ready.then(cleanUp, cleanUp);
      return disposal;
    },
  };
}
