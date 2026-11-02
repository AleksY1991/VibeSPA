import type { DeepReadonly } from './types.js';

/** A forwarding capability, not a projection or entity cache. In particular do
 * not expose Solid's internal symbols: createStore(rawStore) recovers a setter. */
export function readonlyView<T extends object>(value: T): DeepReadonly<T> {
  const wrappers = new WeakMap<object, object>();
  const refuse = (): never => { throw new TypeError('Domain reads are readonly; use a named command.'); };
  const wrap = (source: object): object => {
    const existing = wrappers.get(source);
    if (existing) return existing;
    const array = Array.isArray(source);
    const target = array ? [] : {};
    const proxy = new Proxy(target, {
      get(_target, key, receiver) {
        if (typeof key === 'symbol') {
          if (array && key === Symbol.iterator) return function* () {
            for (let index = 0; index < Reflect.get(source, 'length'); index++) yield Reflect.get(receiver, String(index));
          };
          return undefined;
        }
        const result: unknown = Reflect.get(source, key);
        return result !== null && typeof result === 'object' ? wrap(result) : result;
      },
      has: (_target, key) => typeof key !== 'symbol' && Reflect.has(source, key),
      ownKeys: () => Reflect.ownKeys(source).filter(key => typeof key !== 'symbol'),
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key === 'symbol') return undefined;
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        if (!descriptor) return undefined;
        if (array && key === 'length') return { value: Reflect.get(source, key), writable: true, enumerable: false, configurable: false };
        const current: unknown = Reflect.get(source, key);
        return { value: current !== null && typeof current === 'object' ? wrap(current) : current,
          enumerable: descriptor.enumerable, writable: false, configurable: true };
      },
      set: refuse, deleteProperty: refuse, defineProperty: refuse,
      setPrototypeOf: refuse, preventExtensions: refuse,
      getPrototypeOf: () => array ? Array.prototype : Object.prototype,
    });
    wrappers.set(source, proxy);
    return proxy;
  };
  return wrap(value) as DeepReadonly<T>;
}

/** Copy only bounded input/journal/transport payloads, never a published read
 * collection. Also disallow leaves that bypass Solid's nested proxy tracking. */
export function copyJson<T>(value: T): T {
  const ancestors = new Set<object>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Domain data must be finite, acyclic plain JSON.');
    const prototype: unknown = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Domain data must contain only plain records and arrays.');
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const keys = Reflect.ownKeys(item);
        if (keys.length !== item.length + 1 || keys.some(key => key !== 'length'
          && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) {
          throw new TypeError('Domain arrays must be dense JSON arrays without extra properties.');
        }
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(item, String(index))!;
          if (!('value' in descriptor)) throw new TypeError('Domain data cannot contain getters.');
          return copy(descriptor.value);
        });
      }
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Invalid domain key.');
        const descriptor = Reflect.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new TypeError('Domain data cannot contain getters.');
        result[key] = copy(descriptor.value);
      }
      return result;
    } finally { ancestors.delete(item); }
  };
  return copy(value) as T;
}

/** Only use on owned transport/journal copies, never on a Solid proxy. */
export function freezePayload<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezePayload(child);
    Object.freeze(value);
  }
  return value;
}
