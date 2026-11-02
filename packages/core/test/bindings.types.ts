import { FeatureType, createSystem, defineFeatureModule, external, from } from '@vibespa/core';
import { createSystem as createSystemFromSubpath, external as externalFromSubpath, from as fromSubpath } from '@vibespa/core/system';
import type { ModuleHandle } from '@vibespa/core';

interface Repository {
  find(id: string): string | undefined;
  save(id: string, value: string): Promise<void>;
}

interface ConsumerInputs {
  repository: Pick<Repository, 'find'>;
  titles: { normalize(title: string): string };
  createId: () => string;
  maximumLength?: number;
}

// Compile-only composition uses the public root and system entry points. Each
// factory determines its boundary; calls need neither casts nor type arguments.
async function verifyBoundInputs(repository: Repository) {
  const provider = defineFeatureModule({
    id: 'provider',
    kind: FeatureType.Store,
    title: 'Repository provider',
    description: 'Exports repository and configuration capabilities.',
    contract: {
      inputs: {},
      exports: { repository: 'Repository.', label: 'Provider label.' },
    },
    load: async () => (_inputs: object) => ({ repository, label: 'Local' }),
  });
  const titleProvider = defineFeatureModule({
    id: 'titles',
    kind: FeatureType.Policy,
    title: 'Title policy',
    description: 'Supplies title normalization.',
    contract: {
      inputs: {},
      exports: { normalize: 'Normalize a title.', maximumLength: 'Configured length.' },
    },
    load: async () => (_inputs: object) => ({ normalize: (title: string) => title.trim(), maximumLength: 140 }),
  });
  const consumer = defineFeatureModule({
    id: 'consumer',
    kind: FeatureType.Feature,
    title: 'Repository consumer',
    description: 'Needs only a narrow read contract and title normalization.',
    contract: {
      inputs: {
        repository: 'Find rows.', titles: 'Normalize titles.', createId: 'Create an identifier.',
        maximumLength: 'Optional title limit.',
      },
      exports: { lookup: 'Find or create a normalized title.' },
    },
    load: async () => (inputs: ConsumerInputs) => ({
      lookup: () => inputs.repository.find(inputs.createId()) ?? inputs.titles.normalize('New'),
    }),
  });
  const system = createSystem({ id: 'root' });
  const storage = await system.start(provider, {});
  const titles = await system.start(titleProvider, {});
  const bindings = { repository: from(storage, 'repository'), titles: from(titles), createId: external(() => 'row') };
  const omittedOptional = await system.start(consumer, bindings);
  const suppliedOptional = await system.start(consumer, {
    ...bindings, maximumLength: from(titles, 'maximumLength'),
  }, { id: 'limited' });
  const explicitUndefined = await system.start(consumer, {
    ...bindings, maximumLength: external(undefined),
  }, { id: 'undefined-limit' });
  const externalRepository = await system.start(consumer, {
    ...bindings, repository: external(repository),
  }, { id: 'unchecked-repository' });
  const inferred: ModuleHandle<{ lookup: () => string }> = omittedOptional;
  const result: string = suppliedOptional.exports.lookup() + explicitUndefined.exports.lookup()
    + externalRepository.exports.lookup() + inferred.exports.lookup();

  // @ts-expect-error A key cannot widen the provider's inferred exports.
  from(storage, 'missing');
  // @ts-expect-error The selected export must implement the consumer's repository input.
  await system.start(consumer, { ...bindings, repository: from(storage, 'label') });
  // @ts-expect-error External descriptors retain their value type; inputs cannot widen away an error.
  await system.start(consumer, { ...bindings, createId: external(() => 123) });
  // @ts-expect-error Optional inputs retain their declared type when present.
  await system.start(consumer, { ...bindings, maximumLength: external('many') });
  // @ts-expect-error The required createId input is absent.
  await system.start(consumer, { repository: from(storage, 'repository'), titles: from(titles) });
  // @ts-expect-error Required inputs cannot disappear through inference.
  await system.start(consumer, {});
  // @ts-expect-error A raw repository must be explicitly described as external or selected from a provider.
  await system.start(consumer, { ...bindings, repository });
  // @ts-expect-error A raw configuration function is not an authenticated descriptor.
  await system.start(consumer, { ...bindings, createId: () => 'row' });
  // @ts-expect-error A consumer cannot receive a port absent from its contract.
  await system.start(consumer, { ...bindings, invented: external(result) });
  // @ts-expect-error Dependency edges derive from bindings; a separate list is forbidden.
  await system.start(consumer, bindings, { dependencies: [storage] });
  // @ts-expect-error startBound was merged into start; there is one system start path.
  void system.startBound;
  const independentEdges = { id: 'override', dependencies: [storage] };
  // @ts-expect-error Even non-literal options cannot override derived edges.
  await system.start(consumer, bindings, independentEdges);

  const subpathSystem = createSystemFromSubpath({ id: 'subpath' });
  const subpathStorage = await subpathSystem.start(provider, {});
  const subpathTitles = await subpathSystem.start(titleProvider, {});
  await subpathSystem.start(consumer, {
    repository: fromSubpath(subpathStorage, 'repository'),
    titles: fromSubpath(subpathTitles), createId: externalFromSubpath(() => 'row'),
  });
  await subpathSystem.dispose();
  await system.dispose();
}
void verifyBoundInputs;
