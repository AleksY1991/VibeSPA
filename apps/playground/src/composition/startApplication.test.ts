import { describe, expect, it } from 'vitest';
import { startApplication } from './startApplication';

describe('application startup ownership', () => {
  it('closes an acquired application when its renderer fails to mount', async () => {
    const renderError = new Error('Renderer failed');
    let closed = 0;
    const application = startApplication(
      async () => ({ dispose: async () => { closed++; } }),
      () => { throw renderError; },
    );

    await expect(application.ready).rejects.toBe(renderError);
    await application.dispose();
    expect(closed).toBe(1);
  });

  it('preserves the renderer error and a failed rollback', async () => {
    const renderError = new Error('Renderer failed');
    const cleanupError = new Error('Database failed to close');
    const application = startApplication(
      async () => ({ dispose: async () => { throw cleanupError; } }),
      () => { throw renderError; },
    );

    const error = await application.ready.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([renderError, cleanupError]);
    await expect(application.dispose()).rejects.toBe(cleanupError);
  });

  it('waits for pending acquisition to close and skips mounting an interrupted app', async () => {
    let acquire!: (value: { dispose(): Promise<void> }) => void;
    let closed = false;
    let mounted = false;
    const application = startApplication(
      () => new Promise<{ dispose(): Promise<void> }>((resolve) => { acquire = resolve; }),
      () => { mounted = true; return () => {}; },
    );
    const disposal = application.dispose();
    let disposalFinished = false;
    void disposal.then(() => { disposalFinished = true; });
    await Promise.resolve();
    expect(disposalFinished).toBe(false);

    acquire({ dispose: async () => { closed = true; } });
    await disposal;
    expect(closed).toBe(true);
    expect(mounted).toBe(false);
  });

  it('always closes the app after an unmount failure and keeps teardown idempotent', async () => {
    const unmountError = new Error('Unmount failed');
    const order: string[] = [];
    const application = startApplication(
      async () => ({ dispose: async () => { order.push('application'); } }),
      () => () => { order.push('renderer'); throw unmountError; },
    );
    await application.ready;

    const disposal = application.dispose();
    expect(application.dispose()).toBe(disposal);
    await expect(disposal).rejects.toBe(unmountError);
    expect(order).toEqual(['renderer', 'application']);
  });
});
