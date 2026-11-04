import { afterAll, beforeAll, vi } from 'vitest';
import { flush } from 'solid-js';
import { prepareApplicationUi } from './ui/runtime';

let restoreInternals: (() => void) | undefined;

beforeAll(async () => {
  // Happy DOM omits ElementInternals. Supply the missing browser API while
  // retaining the real prepared controls, their updates and event handling.
  if (!HTMLElement.prototype.attachInternals) {
    const attachInternals = () => {
      let validity: Record<string, boolean> = { valid: true };
      let validationMessage = '';
      return {
        states: new Set<string>(), labels: [], form: null, willValidate: true,
        get validity() { return validity; },
        get validationMessage() { return validationMessage; },
        setFormValue() {},
        setValidity(flags: Record<string, boolean>, message = '') {
          validity = { ...flags, valid: !Object.values(flags).some(Boolean) };
          validationMessage = message;
        },
        checkValidity: () => validity.valid,
        reportValidity: () => validity.valid,
      };
    };
    Object.defineProperty(HTMLElement.prototype, 'attachInternals', { configurable: true, value: attachInternals });
    restoreInternals = () => {
      if (Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'attachInternals')?.value === attachInternals)
        Reflect.deleteProperty(HTMLElement.prototype, 'attachInternals');
    };
  }
  await prepareApplicationUi();
}, 15_000);

afterAll(() => { restoreInternals?.(); });

/** Wait for actual prepared-control updates; preparation failures fail tests. */
export async function settleUi(root: ParentNode = document): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await vi.waitFor(async () => {
    flush();
    const controls = [...root.querySelectorAll<HTMLElement & { updateComplete?: Promise<boolean> }>('*')]
      .filter(element => element.localName.startsWith('wa-'));
    await Promise.all(controls.map(element => element.updateComplete));
    flush();
    const failed = root.querySelector('[data-ui-ready="failed"]');
    if (failed) throw new Error(`Control preparation failed: ${failed.localName} (${failed.getAttribute('data-ui-error')})`);
    const pending = root.querySelector('[data-ui-ready="false"]');
    if (pending) throw new Error(`Control is preparing: ${pending.localName}`);
  }, { timeout: 9_000, interval: 10 });
}

/** Happy DOM omits assigned-slot propagation; retain the real vendor listener. */
export function activateTab(tab: HTMLElement): void {
  const base = tab.closest('wa-tab-group')?.shadowRoot?.querySelector('[part="base tab-group"]');
  if (!base) throw new Error('A mounted tab group is required for tab activation');
  const event = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, 'target', { configurable: true, value: tab });
  const composedPath = event.composedPath.bind(event);
  Object.defineProperty(event, 'composedPath', {
    value: () => [base, tab, ...composedPath().filter(element => element !== base && element !== tab)],
  });
  base.dispatchEvent(event);
}
