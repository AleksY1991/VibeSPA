import { afterEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  failure: new Error('Shared design-system preparation failed.'),
  prepare: vi.fn(),
  createSystem: vi.fn(),
  createApplication: vi.fn(),
  createInteraction: vi.fn(),
  createBackend: vi.fn(),
  startApplication: vi.fn(),
  startGeneration: vi.fn(),
  mount: vi.fn(),
  mountInspector: vi.fn(),
  showStartupError: vi.fn(),
}));

vi.mock('./ui/runtime', () => ({ prepareApplicationUi: startup.prepare }));
vi.mock('@vibespa/solid/module', () => ({ createSolidSystem: startup.createSystem }));
vi.mock('./composition/createApplication', () => ({ applicationModules: [], createApplication: startup.createApplication }));
vi.mock('./composition/createApplicationInteraction', () => ({ createApplicationInteraction: startup.createInteraction }));
vi.mock('./composition/demoRestBackend', () => ({ createDemoRestBackend: startup.createBackend }));
vi.mock('./composition/startApplication', () => ({ startApplication: startup.startApplication }));
vi.mock('./composition/startApplicationGeneration', () => ({ startApplicationGeneration: startup.startGeneration }));
vi.mock('./ui/mount', () => ({ mount: startup.mount, mountInspector: startup.mountInspector, showStartupError: startup.showStartupError }));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('shared UI preparation failure', () => {
  it('shows readable recovery before starting any application resources', async () => {
    document.body.innerHTML = '<div id="app"></div><div id="inspector"></div>';
    startup.prepare.mockRejectedValue(startup.failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./main')).rejects.toBe(startup.failure);

    const target = document.getElementById('app')!;
    expect(target.getAttribute('role')).toBe('alert');
    expect(target.textContent).toContain('Unable to load the Haku design system.');
    expect(target.textContent).toContain('Reload the page to try again.');
    expect(target.querySelector('button')).toBeNull();
    expect(logged).toHaveBeenCalledWith('Unable to prepare the Haku design system', startup.failure);
    expect(startup.prepare).toHaveBeenCalledOnce();
    for (const acquire of [startup.createSystem, startup.createApplication, startup.createInteraction,
      startup.createBackend, startup.startApplication, startup.startGeneration, startup.mount,
      startup.mountInspector, startup.showStartupError]) expect(acquire).not.toHaveBeenCalled();
  });
});
