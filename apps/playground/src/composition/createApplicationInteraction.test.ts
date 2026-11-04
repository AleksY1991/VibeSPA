import { describe, expect, it, vi } from 'vitest';
import { createApplicationInteraction } from './createApplicationInteraction';

describe('application interaction presence', () => {
  it('keeps the transparent inspector above Focus even when Focus renders later', async () => {
    const application = createApplicationInteraction();
    expect(application.snapshot.read().surfaces.every(surface => !surface.active)).toBe(true);
    const unmountInspector = application.mountInspector(() => () => {});
    const unmountFocus = application.mountFocus(() => () => {});
    expect(application.snapshot.read().surfaces.map(surface => ({ id: surface.id, active: surface.active, transparent: surface.transparent, reachable: surface.reachable })))
      .toEqual([
        { id: 'system-inspector', active: true, transparent: true, reachable: true },
        { id: 'focus', active: true, transparent: false, reachable: true },
      ]);

    unmountFocus();
    expect(application.snapshot.read().surfaces.find(surface => surface.id === 'focus')?.active).toBe(false);
    expect(application.snapshot.read().surfaces.find(surface => surface.id === 'system-inspector')?.active).toBe(true);
    unmountInspector();
    await application.dispose();
    expect(application.snapshot.read().state).toBe('disposed');
    expect(application.snapshot.read().surfaces).toEqual([]);
  });

  it('clears presence when rendering or unmounting throws and only unmounts once', async () => {
    const application = createApplicationInteraction();
    const error = new Error('Renderer failed');
    expect(() => application.mountFocus(() => { throw error; })).toThrow(error);
    expect(application.snapshot.read().surfaces.find(surface => surface.id === 'focus')?.active).toBe(false);

    const unmount = vi.fn(() => { throw error; });
    const release = application.mountInspector(() => unmount);
    expect(release).toThrow(error);
    expect(application.snapshot.read().surfaces.find(surface => surface.id === 'system-inspector')?.active).toBe(false);
    release();
    expect(unmount).toHaveBeenCalledTimes(1);
    await application.dispose();
  });
});
