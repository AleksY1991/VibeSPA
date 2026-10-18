export interface Contribution {
  readonly id: string;
  readonly order?: number;
}

export interface Registry<T extends Contribution> {
  readonly items: readonly Readonly<T>[];
  get(id: string): Readonly<T> | undefined;
}

/** Snapshot declaration shells without evaluating loaders or constructors.
 * Payloads remain typed capabilities; consumers decide when to activate them.
 */
export function createRegistry<T extends Contribution>(items: readonly T[]): Registry<T> {
  const byId = new Map<string, Readonly<T>>();
  for (const item of items) {
    if (item.id.trim().length === 0) throw new Error('Contribution id must not be empty');
    if (!Number.isFinite(item.order ?? 0)) throw new Error(`Invalid contribution order: ${item.id}`);
    if (byId.has(item.id)) throw new Error(`Duplicate contribution: ${item.id}`);
    byId.set(item.id, Object.freeze({ ...item }));
  }

  const sorted = [...byId.values()].sort((left, right) => {
    const order = (left.order ?? 0) - (right.order ?? 0);
    return order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });

  return Object.freeze({
    items: Object.freeze(sorted),
    get: (id: string): Readonly<T> | undefined => byId.get(id),
  });
}
