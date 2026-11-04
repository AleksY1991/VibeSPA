import { createScope, createSource } from '@vibespa/core';
import { createInteraction } from '@vibespa/interaction';

/** Track the same presence used to mount each renderer in the interaction stack. */
export function createApplicationInteraction() {
  const scope = createScope();
  const interaction = createInteraction(scope);
  const focus = createSource(false);
  const inspector = createSource(false);

  // Registration order is stable even though diagnostics render before Focus.
  interaction.mount({ id: 'focus', active: focus.source, transparent: false, actions: [] });
  interaction.mount({ id: 'system-inspector', active: inspector.source, transparent: true, actions: [] });

  function present(source: typeof focus, render: () => () => void): () => void {
    source.set(true);
    let unmount: () => void;
    try { unmount = render(); }
    catch (error) { source.set(false); throw error; }
    let mounted = true;
    return () => {
      if (!mounted) return;
      mounted = false;
      try { unmount(); }
      finally { source.set(false); }
    };
  }

  return {
    snapshot: interaction.snapshot,
    mountFocus: (render: () => () => void) => present(focus, render),
    mountInspector: (render: () => () => void) => present(inspector, render),
    dispose: () => scope.dispose(),
  };
}
