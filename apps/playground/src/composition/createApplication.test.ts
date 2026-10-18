import 'fake-indexeddb/auto';
import { FeatureType } from '@vibespa/contracts';
import { createSystem } from '@vibespa/core';
import { describe, expect, it } from 'vitest';
import { createApplication } from './createApplication';

describe('the inspectable application', () => {
  it('tracks real persistence, explicit wiring and public commands through owned teardown', async () => {
    const system = createSystem({ id: 'application-test' });
    try {
      const application = await createApplication(system);
      expect(system.snapshot.read().modules.map(module => [module.id, module.kind, module.state])).toEqual([
        ['local-storage', FeatureType.Store, 'ready'],
        ['title-policy', FeatureType.Policy, 'ready'],
        ['focus', FeatureType.Feature, 'ready'],
      ]);
      expect(system.snapshot.read().modules.find(module => module.id === 'focus')?.dependencies)
        .toEqual(['local-storage', 'title-policy']);

      const privateTitle = 'Private test intention';
      expect(await application.focus.commands.add(privateTitle)).toEqual({ ok: true });
      const intention = application.focus.pending.read().find(item => item.title === privateTitle)!;
      expect(intention).toBeDefined();
      expect(await application.focus.commands.toggle(intention.id)).toEqual({ ok: true });
      expect(application.focus.completed.read().some(item => item.id === intention.id)).toBe(true);
      expect(await application.focus.commands.undo()).toEqual({ ok: true });
      expect(application.focus.pending.read().some(item => item.id === intention.id)).toBe(true);
      expect(await application.focus.commands.redo()).toEqual({ ok: true });
      expect(application.focus.completed.read().some(item => item.id === intention.id)).toBe(true);
      expect(await application.focus.commands.remove(intention.id)).toEqual({ ok: true });

      const snapshot = system.snapshot.read();
      expect(snapshot.events.filter(event => event.type === 'operation-completed').map(event => event.operation))
        .toEqual(['add', 'toggle', 'undo', 'redo', 'remove']);
      expect(JSON.stringify(snapshot)).not.toContain(privateTitle);
      expect(JSON.stringify(snapshot)).not.toContain(intention.id);

      await application.dispose();
      const disposed = system.snapshot.read();
      expect(disposed.state).toBe('disposed');
      expect(disposed.modules.every(module => module.state === 'disposed')).toBe(true);
      expect(disposed.events.filter(event => event.type === 'disposing' && event.moduleId).map(event => event.moduleId))
        .toEqual(['focus', 'title-policy', 'local-storage']);
      await expect(application.focus.commands.add('After disposal')).rejects.toThrow('disposed');
    } finally {
      await system.dispose();
    }
  });
});
