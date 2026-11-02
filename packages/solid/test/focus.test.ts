import { flush, getOwner, isDisposed } from 'solid-js';
import type { Owner } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { focusModule } from '../../../apps/playground/src/modules/focus/definition.js';
import { intentionsDataModule } from '../../../apps/playground/src/modules/intentions-data/definition.js';
import type { Intention } from '../../../apps/playground/src/contracts/focus.js';
import type { DomainAdapter } from '../src/domain/types.js';
import { external, from } from '@vibespa/core';
import { createSolidSystem } from '../src/module.js';

describe('sample command ownership', () => {
  it('enters the Focus and Data owners and joins an in-flight save on disposal', async () => {
    let dataOwner: Owner | null = null;
    let focusOwner: Owner | null = null;
    const dataDefinition: typeof intentionsDataModule = {
      ...intentionsDataModule,
      load: async () => {
        const create = await intentionsDataModule.load();
        return (...args: Parameters<typeof create>) => {
          dataOwner = getOwner();
          return create(...args);
        };
      },
    };
    const focusDefinition: typeof focusModule = {
      ...focusModule,
      load: async () => {
        const create = await focusModule.load();
        return (...args: Parameters<typeof create>) => {
          focusOwner = getOwner();
          return create(...args);
        };
      },
    };
    const system = createSolidSystem({ id: 'sample-commands', modules: [dataDefinition, focusDefinition] });
    const owners: (Owner | null)[] = [];
    let finishWrite!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const writeFinished = new Promise<void>(resolve => { finishWrite = resolve; });
    let closed = false;
    const adapter: DomainAdapter<Intention> = {
      async open() {
        return {
          load: async () => [],
          async save(batch) {
            started();
            await writeFinished;
            return { identity: batch.identity, rows: batch.writes.map(write => ({
              id: write.id, ok: true as const, version: write.expectedVersion + 1, document: write.document,
            })) };
          },
          close() { closed = true; },
        };
      },
    };
    let nextId = 0;
    const titles = { validate: (title: string) => {
      owners.push(getOwner());
      return { valid: true as const, title };
    } };
    const data = await system.start(dataDefinition, {
      adapter: external(adapter),
      generation: external('sample-generation'),
      titles: external(titles),
    });
    const focus = await system.start(focusDefinition, {
      data: from(data, 'data'),
      titles: external(titles),
      createId: external(() => `id-${++nextId}`),
    });
    try {
      expect(getOwner()).toBeNull();
      const command = focus.exports.commands.add('Traced');
      flush();
      expect(focus.exports.pending()[0]?.title).toBe('Traced');
      expect(await command).toEqual({ ok: true });
      await writing;
      expect(focusOwner).not.toBeNull();
      expect(dataOwner).not.toBeNull();
      expect(dataOwner).not.toBe(focusOwner);
      // The feature validates intent under Focus; the Data command separately
      // admits the row under its own runtime, even when invoked from Focus.
      expect(owners).toEqual([focusOwner, dataOwner]);
      expect(owners.every(owner => owner !== null)).toBe(true);

      let disposed = false;
      const closing = system.dispose().then(() => { disposed = true; });
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(closed).toBe(false);
      finishWrite();
      await closing;
      expect(closed).toBe(true);
      expect(isDisposed(focusOwner!)).toBe(true);
      expect(isDisposed(dataOwner!)).toBe(true);
      await expect(focus.exports.commands.add('Too late')).rejects.toThrow('Module focus is disposed');
    } finally { finishWrite(); await system.dispose(); }
  });
});
