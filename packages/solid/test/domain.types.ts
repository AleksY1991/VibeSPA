import type { DomainView } from '../src/domain.js';

declare const view: DomainView<{ id: string; nested: { tags: string[] } }>;
// @ts-expect-error Consumers cannot append rows.
view.rows.push({ id: 'x', nested: { tags: [] } });
// @ts-expect-error Consumers cannot replace a nested record.
view.rows[0]!.nested = { tags: [] };
// @ts-expect-error Consumers cannot mutate nested arrays.
view.rows[0]!.nested.tags.push('x');
// @ts-expect-error Views contain no mutation handle.
view.commit({});
// @ts-expect-error Status is read only.
view.delivery().phase = 'idle';
