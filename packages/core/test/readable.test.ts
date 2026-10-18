import { describe, expect, it, vi } from 'vitest';
import { constantReadable, createSource, mapReadable } from '../src/readable.js';

describe('createSource', () => {
  it('exposes reads without mutation and only reports subsequent changes', () => {
    const owner = createSource(1);
    const listener = vi.fn();
    const unsubscribe = owner.source.subscribe(listener);

    expect(Object.isFrozen(owner.source)).toBe(true);
    expect('set' in owner.source).toBe(false);
    expect('update' in owner.source).toBe(false);
    expect(owner.source.read()).toBe(1);
    expect(listener).not.toHaveBeenCalled();

    owner.set(2);
    owner.update((previous) => previous + 1);
    expect(owner.source.read()).toBe(3);
    expect(listener.mock.calls).toEqual([[2], [3]]);

    unsubscribe();
    unsubscribe();
    owner.set(4);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('uses Object.is by default and accepts an owner-specific equality', () => {
    const number = createSource(Number.NaN);
    const numberChanged = vi.fn();
    number.source.subscribe(numberChanged);
    number.set(Number.NaN);
    number.set(0);
    number.set(-0);
    expect(numberChanged).toHaveBeenCalledTimes(2);

    const owner = createSource({ count: 1 }, (a, b) => a.count === b.count);
    const changed = vi.fn();
    owner.source.subscribe(changed);
    owner.set({ count: 1 });
    owner.set({ count: 2 });
    expect(changed.mock.calls).toEqual([[{ count: 2 }]]);
  });

  it('delivers reentrant changes in the same order to every subscriber', () => {
    const owner = createSource(0);
    const first: number[] = [];
    const second: number[] = [];
    owner.source.subscribe((value) => {
      first.push(value);
      if (value === 1) owner.set(2);
    });
    owner.source.subscribe((value) => second.push(value));

    owner.set(1);

    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
    expect(owner.source.read()).toBe(2);
  });

  it('honors removal during notification and keeps duplicate subscriptions independent', () => {
    const owner = createSource(0);
    const listener = vi.fn();
    let removeSecond = () => {};
    owner.source.subscribe(() => removeSecond());
    removeSecond = owner.source.subscribe(listener);
    owner.source.subscribe(listener);

    owner.set(1);
    owner.set(2);

    expect(listener.mock.calls).toEqual([[1], [2]]);
  });

  it('does not deliver an earlier change to a subscriber added during notification', () => {
    const owner = createSource(0);
    const late = vi.fn();
    owner.source.subscribe((value) => {
      if (value === 1) owner.source.subscribe(late);
    });

    owner.set(1);
    expect(late).not.toHaveBeenCalled();
    owner.set(2);
    expect(late.mock.calls).toEqual([[2]]);
  });

  it('finishes notifications after a listener throws and remains usable', () => {
    const owner = createSource(0);
    const failure = new Error('subscriber failed');
    const removeFailure = owner.source.subscribe(() => { throw failure; });
    const listener = vi.fn();
    owner.source.subscribe(listener);

    expect(() => owner.set(1)).toThrow(AggregateError);
    expect(owner.source.read()).toBe(1);
    expect(listener.mock.calls).toEqual([[1]]);

    removeFailure();
    owner.set(2);
    expect(listener.mock.calls).toEqual([[1], [2]]);
  });
});

describe('readable derivation', () => {
  it('offers a constant source without an eager subscription event', () => {
    const source = constantReadable('steady');
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    unsubscribe();
    unsubscribe();
    expect(Object.isFrozen(source)).toBe(true);
    expect(source.read()).toBe('steady');
    expect(listener).not.toHaveBeenCalled();
  });

  it('suppresses unrelated upstream changes and releases its subscription', () => {
    const owner = createSource({ selected: 'a', unrelated: 0 });
    const selected = mapReadable(owner.source, (value) => value.selected);
    const listener = vi.fn();
    const unsubscribe = selected.subscribe(listener);

    expect(Object.isFrozen(selected)).toBe(true);
    expect(selected.read()).toBe('a');
    expect(listener).not.toHaveBeenCalled();
    owner.set({ selected: 'a', unrelated: 1 });
    owner.set({ selected: 'b', unrelated: 1 });
    expect(listener.mock.calls).toEqual([['b']]);
    unsubscribe();
    owner.set({ selected: 'c', unrelated: 2 });
    expect(selected.read()).toBe('c');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('compares selection-sized projections using the consumer equality', () => {
    const owner = createSource({ count: 1, name: 'a' });
    const count = mapReadable(
      owner.source,
      (value) => ({ count: value.count }),
      (previous, next) => previous.count === next.count,
    );
    const listener = vi.fn();
    count.subscribe(listener);

    owner.set({ count: 1, name: 'b' });
    owner.set({ count: 2, name: 'b' });
    expect(listener.mock.calls).toEqual([[{ count: 2 }]]);
  });
});
