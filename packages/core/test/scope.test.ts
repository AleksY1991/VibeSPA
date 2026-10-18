import { describe, expect, it } from 'vitest';
import { createScope } from '../src/scope.js';

describe('scope ownership', () => {
  it('aborts first and awaits cleanups in reverse registration order', async () => {
    const scope = createScope();
    const events: string[] = [];
    scope.signal.addEventListener('abort', () => events.push('abort'));
    scope.defer(() => { events.push('dependency'); });
    scope.defer(async () => {
      expect(scope.signal.aborted).toBe(true);
      events.push('dependent:start');
      await Promise.resolve();
      events.push('dependent:end');
    });
    await scope.dispose();
    expect(events).toEqual(['abort', 'dependent:start', 'dependent:end', 'dependency']);
  });

  it('continues cleanup after failures, unregisters entries, and disposes once', async () => {
    const scope = createScope();
    const events: string[] = [];
    scope.defer(() => { events.push('last'); throw new Error('last failure'); });
    const unregister = scope.defer(() => { events.push('unregistered'); });
    unregister();
    unregister();
    scope.defer(async () => { events.push('first'); throw new Error('first failure'); });
    const first = scope.dispose();
    const second = scope.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'first failure' }), expect.objectContaining({ message: 'last failure' })],
    });
    expect(events).toEqual(['first', 'last']);
    expect(() => scope.defer(() => {})).toThrow('disposing scope');
  });

  it('forwards parent cancellation while leaving teardown with the owner', async () => {
    const controller = new AbortController();
    const scope = createScope(controller.signal);
    let disposed = false;
    scope.defer(() => { disposed = true; });
    controller.abort('session changed');
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe('session changed');
    expect(disposed).toBe(false);
    await scope.dispose();
    expect(disposed).toBe(true);
  });

  it('handles an already aborted parent and reentrant disposal', async () => {
    const parent = new AbortController();
    parent.abort('ended');
    expect(createScope(parent.signal).signal.reason).toBe('ended');
    const scope = createScope();
    let nested: Promise<void> | undefined;
    scope.signal.addEventListener('abort', () => { nested = scope.dispose(); });
    const disposal = scope.dispose();
    expect(nested).toBe(disposal);
    await disposal;
  });
});
