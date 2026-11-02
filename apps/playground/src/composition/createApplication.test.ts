import 'fake-indexeddb/auto';
import { flush } from 'solid-js';
import { FeatureType } from '@vibespa/contracts';
import { createSolidSystem as createSystem } from '@vibespa/solid/module';
import { describe, expect, it } from 'vitest';
import { applicationModules, createApplication } from './createApplication';
import { createDemoRestBackend } from './demoRestBackend';

async function delivered(application: Awaited<ReturnType<typeof createApplication>>) {
  for (let count = 0; count < 200 && ['loading', 'saving'].includes(application.focus.delivery().phase); count++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(application.focus.delivery()).toMatchObject({ phase: 'idle', pending: 0, error: null });
}

describe('the inspectable application', () => {
  it('tracks real persistence, bound wiring and public commands through owned teardown', async () => {
    const system = createSystem({ id: 'application-test', modules: applicationModules });
    try {
      const application = await createApplication(system);
      expect(system.snapshot.read().modules.map(module => [module.id, module.kind, module.state])).toEqual([
        ['local-storage', FeatureType.Store, 'ready'],
        ['title-policy', FeatureType.Policy, 'ready'],
        ['intentions-data', FeatureType.Data, 'ready'],
        ['focus', FeatureType.Feature, 'ready'],
      ]);
      expect(system.snapshot.read().modules.find(module => module.id === 'focus')?.dependencies)
        .toEqual(['intentions-data', 'title-policy']);
      expect(system.snapshot.read().modules.find(module => module.id === 'intentions-data')?.dependencies)
        .toEqual(['local-storage', 'title-policy']);
      expect(system.snapshot.read().data).toEqual([{
        id: 'intentions',
        version: 0,
        provider: { definitionId: 'intentions-data', port: 'data', capabilities: ['read', 'write', 'live', 'local-apply'] },
        consumers: [{ definitionId: 'focus', port: 'data', capabilities: ['read', 'write', 'live', 'local-apply'] }],
        relations: [],
      }]);

      const privateTitle = 'Private test intention';
      expect(await application.focus.commands.add(privateTitle)).toEqual({ ok: true });
      const intention = application.focus.pending().find(item => item.title === privateTitle)!;
      expect(intention).toBeDefined();
      expect(await application.focus.commands.toggle(intention.id)).toEqual({ ok: true });
      expect(application.focus.completed().some(item => item.id === intention.id)).toBe(true);
      expect(await application.focus.commands.undo()).toEqual({ ok: true });
      expect(application.focus.pending().some(item => item.id === intention.id)).toBe(true);
      expect(await application.focus.commands.redo()).toEqual({ ok: true });
      expect(application.focus.completed().some(item => item.id === intention.id)).toBe(true);
      expect(await application.focus.commands.remove(intention.id)).toEqual({ ok: true });

      const snapshot = system.snapshot.read();
      expect(snapshot.events.filter(event => event.type === 'operation-completed' && event.moduleId === 'focus').map(event => event.operation))
        .toEqual(['add', 'toggle', 'undo', 'redo', 'remove']);
      expect(snapshot.events.filter(event => event.type === 'operation-completed' && event.moduleId === 'intentions-data').map(event => event.operation))
        .toEqual(['commit', 'commit', 'undo', 'redo', 'commit']);
      expect(JSON.stringify(snapshot)).not.toContain(privateTitle);
      expect(JSON.stringify(snapshot)).not.toContain(intention.id);

      await delivered(application);
      await application.dispose();
      const disposed = system.snapshot.read();
      expect(disposed.state).toBe('disposed');
      expect(disposed.modules.every(module => module.state === 'disposed')).toBe(true);
      expect(disposed.events.filter(event => event.type === 'disposing' && event.moduleId).map(event => event.moduleId))
        .toEqual(['focus', 'intentions-data', 'title-policy', 'local-storage']);
      await expect(application.focus.commands.add('After disposal')).rejects.toThrow('disposed');
    } finally {
      await system.dispose();
    }
  });

  it('retains locally persisted intentions when the bound composition restarts', async () => {
    const firstSystem = createSystem({ id: 'application-first-generation', modules: applicationModules });
    let intentionId!: string;
    try {
      const application = await createApplication(firstSystem);
      const title = `Persisted between application generations ${crypto.randomUUID()}`;
      expect(await application.focus.commands.add(title)).toEqual({ ok: true });
      intentionId = application.focus.pending().find(item => item.title === title)!.id;
      // Local command completion does not imply disk acceptance.
      await delivered(application);
    } finally {
      await firstSystem.dispose();
    }

    const secondSystem = createSystem({ id: 'application-second-generation', modules: applicationModules });
    try {
      const application = await createApplication(secondSystem);
      expect(application.focus.pending().some(item => item.id === intentionId)).toBe(true);
      expect(await application.focus.commands.remove(intentionId)).toEqual({ ok: true });
      await delivered(application);
    } finally {
      await secondSystem.dispose();
    }
  });

  it('uses the same feature API and read contract without a backend', async () => {
    const system = createSystem({ id: 'memory-application', modules: applicationModules });
    try {
      const application = await createApplication(system, { adapter: null });
      expect(system.snapshot.read().modules.map(module => module.id)).toEqual(['title-policy', 'intentions-data', 'focus']);
      const admitted = application.focus.commands.add('Memory only');
      flush();
      expect(application.focus.pending()[0]?.title).toBe('Memory only');
      expect(await admitted).toEqual({ ok: true });
      expect(application.focus.delivery().phase).toBe('memory');
      expect(system.snapshot.read().modules.find(module => module.id === 'focus')?.dependencies).toEqual(['intentions-data', 'title-policy']);
    } finally { await system.dispose(); }
  });

  it('uses the same feature API against a controlled REST server and exposes retryable delivery', async () => {
    const backend = createDemoRestBackend({ initial: [{ id: 'remote', title: 'Loaded from REST', done: false }] });
    const system = createSystem({ id: 'rest-application', modules: applicationModules });
    try {
      const application = await createApplication(system, { adapter: backend.adapter });
      expect(application.focus.pending()[0]?.title).toBe('Loaded from REST');
      backend.setOffline(true);
      const admitted = application.focus.commands.toggle('remote');
      flush();
      expect(application.focus.completed()[0]?.id).toBe('remote');
      expect(await admitted).toEqual({ ok: true });
      for (let count = 0; count < 100 && application.focus.delivery().phase !== 'failed'; count++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(application.focus.delivery()).toMatchObject({ phase: 'failed', pending: 1 });
      expect(application.focus.completed()[0]?.id).toBe('remote');
      backend.setOffline(false);
      await application.focus.commands.retry();
      await delivered(application);
      expect(backend.read().find(row => row.id === 'remote')?.document?.done).toBe(true);
      expect(backend.requests.map(request => request.method)).toEqual(['GET', 'POST', 'POST']);
    } finally { await system.dispose(); }
  });
});
