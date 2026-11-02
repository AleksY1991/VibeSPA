import { createSolidSystem } from '@vibespa/solid/module';
import { applicationModules, createApplication } from './composition/createApplication';
import { createDemoRestBackend } from './composition/demoRestBackend';
import { startApplication } from './composition/startApplication';
import { startApplicationGeneration, type ApplicationGeneration } from './composition/startApplicationGeneration';
import { mount, mountInspector, showStartupError } from './ui/mount';

interface ApplicationHotData {
  generation?: ApplicationGeneration;
}

const target = document.getElementById('app');
if (!target) throw new Error('The application mount element is missing.');
const inspectorTarget = document.getElementById('inspector');
if (!inspectorTarget) throw new Error('The inspector mount element is missing.');

const system = createSolidSystem({ id: 'playground', modules: applicationModules });
const backend = new URLSearchParams(location.search).get('backend');
const applicationOptions = backend === 'memory' ? { adapter: null }
  : backend === 'rest' ? { adapter: createDemoRestBackend({ latencyMs: 250 }).adapter } : {};
const generation = startApplicationGeneration({
  previous: (import.meta.hot?.data as ApplicationHotData | undefined)?.generation,
  mountInspector: () => mountInspector(inspectorTarget, system.snapshot, () => system.clearEvents()),
  startApplication: () => startApplication(() => createApplication(system, applicationOptions), (running) => mount(target, running.focus)),
  disposeSystem: () => system.dispose(),
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
}
