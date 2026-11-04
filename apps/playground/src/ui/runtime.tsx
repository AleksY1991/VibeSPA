/** @jsxImportSource @solidjs/web */
import { createComponent, onCleanup } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { prepareAppImplementation } from '@ui-kit/core/bootstrap';
import type { PreparedImplementation } from '@ui-kit/core/bootstrap';
import { UiRootImplementation } from '@ui-kit/core/infrastructure/renderUiRoot';
import { HotkeyElementContext, HotkeyRendererContext } from '@ui-kit/core/runtime/context';
import { configureSurfacePlatform } from '@ui-kit/core/runtime/platform';
import { createUiSurfacePlatform } from './surfacePlatform';

let prepared: PreparedImplementation | undefined;
let preparation: Promise<void> | undefined;
let authority: ReturnType<typeof createUiSurfacePlatform> | undefined;
let rootCount = 0;
let stopDispatch: (() => void) | undefined;

/** One vendor preparation serves every separately owned application UI root. */
export function prepareApplicationUi(): Promise<void> {
  preparation ??= prepareAppImplementation().then(implementation => { prepared = implementation; }).catch(error => { preparation = undefined; throw error; });
  return preparation;
}

/** Every root has a real renderer lifetime and the shared design-system scope. */
export function mountUiRoot(target: HTMLElement, id: string, code: () => JSX.Element): () => void {
  const implementation = prepared;
  if (!implementation) throw new Error('Prepare the shared UI implementation before mounting.');
  authority ??= createUiSurfacePlatform(target.ownerDocument);
  const releasePlatform = configureSurfacePlatform(authority.platform);
  if (rootCount++ === 0) stopDispatch = authority.attach();
  authority.platform.registerRenderer({ id, transparent: id !== 'focus' });
  const lease = authority.platform.mountRenderer(id);
  const listeners = new Set<() => void>();
  let currentId: string | null = lease.instanceId;
  let unmount: (() => void) | undefined;
  const release = () => {
    currentId = null;
    for (const listener of [...listeners]) listener();
    listeners.clear();
    lease.dispose();
    releasePlatform();
    if (--rootCount === 0) { stopDispatch?.(); stopDispatch = undefined; }
  };
  try {
    unmount = render(() => {
      onCleanup(() => { currentId = null; for (const listener of [...listeners]) listener(); });
      const context = {
        active: () => currentId !== null,
        instanceId: () => currentId,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
      return <HotkeyRendererContext value={context}><HotkeyElementContext value={null}>
        <UiRootImplementation host={target} implementation={implementation}>{createComponent(code, {})}</UiRootImplementation>
      </HotkeyElementContext></HotkeyRendererContext>;
    }, target);
  } catch (error) { release(); throw error; }
  let active = true;
  return () => { if (!active) return; active = false; try { unmount?.(); } finally { release(); } };
}
