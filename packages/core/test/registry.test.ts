import { describe, expect, it, vi } from 'vitest';
import { createRegistry } from '../src/registry.js';

describe('contribution registry', () => {
  it('orders deterministically, copies and freezes declarations, and never loads them', () => {
    const load = vi.fn();
    const first = { id: 'z', order: 0, load };
    const registry = createRegistry([first, { id: 'b', order: 3, load }, { id: 'a', order: 0, load }]);
    first.order = 100;
    expect(registry.items.map(item => item.id)).toEqual(['a', 'z', 'b']);
    expect(registry.get('z')?.order).toBe(0);
    expect(registry.get('absent')).toBeUndefined();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.items)).toBe(true);
    expect(Object.isFrozen(registry.items[0])).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects duplicate identities, empty identities and non-finite order', () => {
    expect(() => createRegistry([{ id: 'same' }, { id: 'same' }])).toThrow('Duplicate contribution: same');
    expect(() => createRegistry([{ id: ' ' }])).toThrow('must not be empty');
    expect(() => createRegistry([{ id: 'bad', order: Number.NaN }])).toThrow('Invalid contribution order: bad');
  });
});
