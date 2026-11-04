import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOTKEY_DELEGATE } from '@ui-kit/core/contracts/platform';
import { createUiSurfacePlatform } from './surfacePlatform';

const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); document.body.replaceChildren(); });

function fixture() {
  const host = createUiSurfacePlatform(document);
  releases.push(host.attach());
  host.platform.registerRenderer({ id: 'view', transparent: false });
  const renderer = host.platform.mountRenderer('view');
  releases.push(renderer.dispose);
  const element = document.createElement('section');
  document.body.append(element);
  return { ...host, renderer, element };
}

describe('shared control surface platform', () => {
  it('keeps control activation under an owned renderer and releases descendants with it', () => {
    const app = fixture();
    const parent = app.platform.mountElement({ name: 'group', element: app.element, parentId: app.renderer.instanceId, transparent: false, layer: false, keys: {} });
    const child = document.createElement('button'); app.element.append(child);
    const control = app.platform.mountElement({ name: 'button', element: child, parentId: parent.instanceId, transparent: false, layer: false, keys: {}, delegate: 'all' });
    expect(control.authority.canActivate()).toBe(true);
    parent.dispose();
    expect(control.authority.canActivate()).toBe(false);
    control.dispose();
  });

  it('preserves browser-owned activation keys and dispatches only declared custom keys', () => {
    const app = fixture();
    const button = document.createElement('button'); button.setAttribute('data-ui-keyboard-owner', 'Enter Space'); app.element.append(button);
    const custom = vi.fn();
    const accidentalEnter = vi.fn();
    const control = app.platform.mountElement({ name: 'button', element: button, parentId: app.renderer.instanceId, transparent: false, layer: false, keys: { Enter: accidentalEnter, 'Ctrl+S': custom }, delegate: 'all' });
    releases.push(control.dispose);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
    button.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(accidentalEnter).not.toHaveBeenCalled();
    const save = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, composed: true, cancelable: true });
    button.dispatchEvent(save);
    expect(custom).toHaveBeenCalledOnce();
    expect(save.defaultPrevented).toBe(true);
  });

  it('delegates an explicit control key to its declared parent', () => {
    const app = fixture();
    const close = vi.fn();
    const parent = app.platform.mountElement({ name: 'panel', element: app.element, parentId: app.renderer.instanceId, transparent: false, layer: false, keys: { Escape: close } });
    const button = document.createElement('button'); app.element.append(button);
    const child = app.platform.mountElement({ name: 'button', element: button, parentId: parent.instanceId, transparent: false, layer: false, keys: { Escape: () => HOTKEY_DELEGATE }, delegate: 'all' });
    releases.push(child.dispose, parent.dispose);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains a layer identity while changes in modality gate outside controls', () => {
    const app = fixture();
    const outside = app.platform.mountElement({ name: 'outside', element: app.element, parentId: app.renderer.instanceId, transparent: false, layer: false, keys: {} });
    const dialog = document.createElement('section'); document.body.append(dialog);
    const layer = app.platform.mountElement({ name: 'dialog', element: dialog, parentId: app.renderer.instanceId, transparent: false, layer: true, modal: true, dismissable: true, keys: {} });
    releases.push(layer.dispose, outside.dispose);
    const id = layer.instanceId;
    expect(outside.authority.canActivate()).toBe(false);
    expect(outside.authority.canMoveFocus()).toBe(false);
    expect(layer.authority.canActivate()).toBe(true);
    layer.update({ layer: false, modal: false });
    expect(layer.instanceId).toBe(id);
    expect(outside.authority.canActivate()).toBe(true);
    expect(outside.authority.canMoveFocus()).toBe(true);
  });
});
