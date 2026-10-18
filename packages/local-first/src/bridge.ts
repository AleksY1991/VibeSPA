import type { RxCollection } from 'rxdb';
import type { CollectionName, LocalStore, RowMap } from './types.js';

const bridges = new WeakMap<object, (name: string) => RxCollection<object>>();

export function registerBridge(store: object, collection: (name: string) => RxCollection<object>): void {
  bridges.set(store, collection);
}

export function getCollection<Rows extends RowMap<Rows>, Name extends CollectionName<Rows>>(
  store: LocalStore<Rows>, name: Name,
): RxCollection<Rows[Name]> {
  const bridge = bridges.get(store);
  if (!bridge) throw new Error('This store was not created by @vibespa/local-first.');
  return bridge(name) as unknown as RxCollection<Rows[Name]>;
}
