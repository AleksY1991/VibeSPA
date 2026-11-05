import { contributionPort, createSystem, defineContributionContract, defineFeatureModule, FeatureType } from '@vibespa/core';
import type { ContributionRegistry } from '@vibespa/core/contributions';

interface Label { readonly title: string }
const labels = defineContributionContract<Label>({ id: 'typed-labels', version: 1 });
const numbers = defineContributionContract<number>({ id: 'typed-numbers', version: 1 });
type Empty = Record<string, never>;
type Provided = Parameters<typeof defineFeatureModule<FeatureType.Feature, Empty, { label: Label }>>[0];
declare const provider: Provided;
const badProvider: Provided = {
  ...provider,
  // @ts-expect-error A contribution port must match the named export's actual value.
  contributions: { provides: { label: contributionPort(numbers) } },
};
void badProvider;

type Consumed = Parameters<typeof defineFeatureModule<FeatureType.Service, { registry: ContributionRegistry<Label> }, Empty>>[0];
declare const consumer: Consumed;
const badConsumer: Consumed = {
  ...consumer,
  // @ts-expect-error A registry requirement retains the canonical contract's value type.
  contributions: { requires: { registry: contributionPort(numbers) } },
};
void badConsumer;

const nonRegistry: Parameters<typeof defineFeatureModule<FeatureType.Service, { count: number }, Empty>>[0] = {
  id: 'bad-input', kind: FeatureType.Service, title: 'Bad', description: 'A number is not a contribution registry.',
  contract: { inputs: { count: 'A count.' }, exports: {} },
  // @ts-expect-error Only registry inputs can declare contribution requirements.
  contributions: { requires: { count: contributionPort(numbers) } },
  load: async () => () => ({}),
};
void nonRegistry;

async function collectionInputs() {
  const definition = defineFeatureModule<FeatureType.Service, { registry: ContributionRegistry<Label> }, Empty>(consumer);
  const system = createSystem({ id: 'types' });
  await system.start(definition, { registry: system.collect(labels) });
  // @ts-expect-error Collection binding types cannot widen a consumer's value type.
  await system.start(definition, { registry: system.collect(numbers) });
  const registry = system.contributions(labels);
  const title: string | undefined = registry.items.read()[0]?.value.title;
  // @ts-expect-error A consumer only receives readonly entries.
  registry.items.read().push({ title: 'mutated' });
  // @ts-expect-error Registry owners never escape from the system.
  registry.items.set([]);
  await system.dispose();
  return title;
}
void collectionInputs;
