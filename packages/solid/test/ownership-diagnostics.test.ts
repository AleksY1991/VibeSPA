// Ownership guardrail: Solid's own diagnostics channel, asserted by the shared
// test setup (test-support/solid-diagnostics.ts). Negative cases assert exactly
// the diagnostics they provoke; anything else fails the test during teardown.
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createSource, defineFeatureModule, FeatureType } from '@vibespa/core';
import type { ModuleContext } from '@vibespa/core/module';
import { takeSolidDiagnostics } from '../../../test-support/solid-diagnostics.js';
import { createModuleEffect, createSolidSystem, moduleAccessor, onModuleCleanup } from '../src/module.js';

function feature(id: string, create: (scope: ModuleContext) => Promise<{ read(): number }> | { read(): number }) {
  return defineFeatureModule<FeatureType.Service, Record<string, never>, { read(): number }>({
    id, kind: FeatureType.Service, title: id, description: `Owns ${id}.`,
    contract: { inputs: {}, exports: { read: 'Read the value.' } },
    load: async () => (_inputs, scope) => create(scope),
  });
}
const codes = () => takeSolidDiagnostics().map(event => event.code);

describe('Solid ownership diagnostics', () => {
  it('report nothing for managed helpers used after an await', async () => {
    const system = createSolidSystem({ id: 'managed' });
    const source = createSource(1);
    await system.start(feature('managed', async scope => {
      await Promise.resolve();
      const value = moduleAccessor(scope, source.source);
      createModuleEffect(scope, () => value(), () => {});
      onModuleCleanup(scope, () => {});
      // Raw primitives are owned inside scope.run; the lint policy still prefers helpers.
      const doubled = scope.run(() => createMemo(() => value() * 2));
      return { read: doubled };
    }), {});
    source.set(2);
    await system.dispose();
    expect(codes()).toEqual([]);
  });

  it('report raw effects and cleanup created after an await, outside the module owner', async () => {
    const system = createSolidSystem({ id: 'leaky' });
    const [count] = createSignal(0);
    await system.start(feature('leaky', async () => {
      await Promise.resolve();
      createEffect(() => count(), () => {});
      onCleanup(() => {});
      return { read: count };
    }), {});
    await system.dispose();
    expect(codes()).toEqual(['NO_OWNER_EFFECT', 'NO_OWNER_CLEANUP']);
  });

  it('do not report an unowned memo (a documented gap)', async () => {
    const system = createSolidSystem({ id: 'memo-gap' });
    await system.start(feature('memo-gap', async () => {
      await Promise.resolve();
      return { read: createMemo(() => 1) };
    }), {});
    await system.dispose();
    expect(codes()).toEqual([]);
  });
});
