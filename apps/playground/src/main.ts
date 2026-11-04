import { createSolidSystem } from '@vibespa/solid/module';
import { applicationModules, createApplication } from './composition/createApplication';
import { createApplicationInteraction } from './composition/createApplicationInteraction';
import { createDemoRestBackend } from './composition/demoRestBackend';
import { startApplication } from './composition/startApplication';
import { startApplicationGeneration, type ApplicationGeneration } from './composition/startApplicationGeneration';
import { mount, mountInspector, showStartupError } from './ui/mount';
import { prepareApplicationUi } from './ui/runtime';

interface ApplicationHotData {
  generation?: ApplicationGeneration;
}

const target = document.getElementById('app');
if (!target) throw new Error('The application mount element is missing.');
const inspectorTarget = document.getElementById('inspector');
if (!inspectorTarget) throw new Error('The inspector mount element is missing.');

try {
  await prepareApplicationUi();
} catch (error) {
  // Shared controls are unavailable here; retain readable recovery text without
  // substituting a locally implemented button or starting application resources.
  target.setAttribute('role', 'alert');
  target.textContent = 'Unable to load the Haku design system. Reload the page to try again.';
  console.error('Unable to prepare the Haku design system', error);
  throw error;
}

const system = createSolidSystem({ id: 'playground', modules: applicationModules });
const interaction = createApplicationInteraction();
const backend = new URLSearchParams(location.search).get('backend');
const applicationOptions = backend === 'memory' ? { adapter: null }
  : backend === 'rest' ? { adapter: createDemoRestBackend({ latencyMs: 250 }).adapter } : {};
const generation = startApplicationGeneration({
  previous: (import.meta.hot?.data as ApplicationHotData | undefined)?.generation,
  mountInspector: () => interaction.mountInspector(() => mountInspector(inspectorTarget, system.snapshot, () => system.clearEvents(), interaction.snapshot)),
  startApplication: () => startApplication(() => createApplication(system, applicationOptions), (running) => interaction.mountFocus(() => mount(target, running.focus))),
  disposeSystem: async () => {
    await system.dispose();
    await interaction.dispose();
  },
  showStartupError: () => showStartupError(target),
});

if (import.meta.hot) {
  import.meta.hot.dispose((data: ApplicationHotData) => {
    // Vite does not await dispose callbacks. The replacement entry explicitly
    // waits for this generation before opening the same database again.
    data.generation = generation;
    void generation.dispose().catch((error: unknown) => { console.error('Unable to dispose VibeSPA', error); });
  });
}

try {
  await generation.ready;
} catch (error) {
  console.error('Unable to start VibeSPA', error);
} finally {
  // The inspector mounts after shared control preparation, so the browser's
  // initial fragment navigation can run before its target exists.
  if (location.hash === '#system-inspector') document.getElementById('system-inspector')?.scrollIntoView({ block: 'start' });
}
