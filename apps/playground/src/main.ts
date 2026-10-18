import { createSystem } from '@vibespa/core';
import { createApplication } from './composition/createApplication';
import { startApplication, type RunningApplication } from './composition/startApplication';
import { mount, mountInspector, showStartupError } from './ui/mount';

interface ApplicationHotData {
  disposal?: Promise<void>;
}

const target = document.getElementById('app');
if (!target) throw new Error('The application mount element is missing.');
const inspectorTarget = document.getElementById('inspector');
if (!inspectorTarget) throw new Error('The inspector mount element is missing.');

const previousDisposal = (import.meta.hot?.data as ApplicationHotData | undefined)?.disposal ?? Promise.resolve();
const system = createSystem({ id: 'playground' });
let application: RunningApplication | undefined;
let unmountInspector: (() => void) | undefined;
let unmountError: (() => void) | undefined;
let invalidated = false;

if (import.meta.hot) {
  import.meta.hot.dispose((data: ApplicationHotData) => {
    invalidated = true;
    // Vite does not await dispose callbacks. The replacement entry explicitly
    // awaits this promise before opening another instance of the same database.
    data.disposal = previousDisposal.then(async () => {
      try {
        await application?.dispose();
        await system.dispose();
      } finally {
        unmountInspector?.();
        unmountError?.();
      }
    });
    void data.disposal.catch((error: unknown) => { console.error('Unable to dispose VibeSPA', error); });
  });
}

try {
  await previousDisposal;
  if (!invalidated) {
    unmountInspector = mountInspector(inspectorTarget, system.snapshot, () => system.clearEvents());
    application = startApplication(() => createApplication(system), (running) => mount(target, running.focus));
    await application.ready;
  }
} catch (error) {
  console.error('Unable to start VibeSPA', error);
  if (!invalidated) unmountError = showStartupError(target);
}
