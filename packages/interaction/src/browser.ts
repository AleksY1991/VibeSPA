import type { Scope } from '@vibespa/contracts';
import type { Interaction } from './index.js';
import { normalizeKey } from './key.js';

export interface KeyboardOptions {
  readonly scope: Scope;
  readonly interaction: Interaction;
  readonly target?: EventTarget;
  readonly onError?: (error: unknown) => void;
}

const attached = new WeakSet<EventTarget>();

const editable = (event: KeyboardEvent): boolean => event.composedPath().some(target => {
  if (!(target instanceof Element)) return false;
  return target.matches('input, textarea, select') || (target instanceof HTMLElement && target.isContentEditable);
});

/** Attach the one dispatcher for a browser target; the scope owns its release. */
export function attachKeyboard(options: KeyboardOptions): () => void {
  const { scope, interaction } = options;
  if (scope.signal.aborted) throw new Error('Cannot attach keyboard handling in an ended scope.');
  const target = options.target ?? window;
  if (attached.has(target)) throw new Error('This target already has an interaction keyboard dispatcher.');
  const onError = options.onError ?? ((error: unknown) => console.error('Keyboard action failed.', error));
  const keydown = (event: Event) => {
    if (scope.signal.aborted || !(event instanceof KeyboardEvent) || event.defaultPrevented || event.isComposing) return;
    if (['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return;
    const key = normalizeKey([
      ...(event.ctrlKey ? ['ctrl'] : []), ...(event.altKey ? ['alt'] : []),
      ...(event.shiftKey ? ['shift'] : []), ...(event.metaKey ? ['meta'] : []),
      event.key === '+' ? 'plus' : event.key === ' ' ? 'space' : event.key,
    ].join('+'));
    const resolved = interaction.resolveKey(key, { editable: editable(event) });
    if (!resolved) return;
    event.preventDefault();
    void resolved.invoke().catch(onError);
  };

  let released = false;
  let unregister: (() => void) | undefined;
  const release = () => {
    if (released) return;
    released = true;
    target.removeEventListener('keydown', keydown);
    scope.signal.removeEventListener('abort', release);
    attached.delete(target);
    unregister?.();
  };
  target.addEventListener('keydown', keydown);
  attached.add(target);
  scope.signal.addEventListener('abort', release, { once: true });
  try { unregister = scope.defer(release); }
  catch (error) { release(); throw error; }
  return release;
}
