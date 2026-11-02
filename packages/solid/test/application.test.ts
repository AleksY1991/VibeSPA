import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { applicationModules, createApplication } from '../../../apps/playground/src/composition/createApplication.js';
import { createSolidSystem } from '../src/module.js';

describe('the sample under Solid module ownership', () => {
  it('closes real storage before a replacement reopens its persisted intentions', async () => {
    const first = createSolidSystem({ id: 'first-application', modules: applicationModules });
    const second = createSolidSystem({ id: 'replacement-application', modules: applicationModules });
    const title = `Owned lifetime ${crypto.randomUUID()}`;
    try {
      const application = await createApplication(first);
      expect(await application.focus.commands.add(title)).toEqual({ ok: true });
      const intention = application.focus.pending().find(item => item.title === title)!;
      expect(intention).toBeDefined();

      for (let count = 0; count < 200 && application.focus.delivery().phase === 'saving'; count++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(application.focus.delivery()).toMatchObject({ phase: 'idle', pending: 0 });

      await application.dispose();
      expect(first.snapshot.read().state).toBe('disposed');
      expect(first.snapshot.read().modules.every(module => module.state === 'disposed')).toBe(true);
      await expect(application.focus.commands.add('After shutdown')).rejects.toThrow('disposed');

      const replacement = await createApplication(second);
      expect(second.snapshot.read().modules.every(module => module.state === 'ready')).toBe(true);
      expect(replacement.focus.pending().find(item => item.id === intention.id)?.title).toBe(title);
      expect(await replacement.focus.commands.remove(intention.id)).toEqual({ ok: true });
      for (let count = 0; count < 200 && replacement.focus.delivery().phase === 'saving'; count++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(replacement.focus.delivery()).toMatchObject({ phase: 'idle', pending: 0 });
      await replacement.dispose();
      expect(second.snapshot.read().state).toBe('disposed');
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });
});
