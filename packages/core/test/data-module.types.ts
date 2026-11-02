// Public compile-time contract: Data is a specialization of FeatureModule.
import { dataPort, defineDataContract, defineFeatureModule, FeatureType } from '@vibespa/core';
import type { FeatureModule } from '@vibespa/core';

type Empty = Record<string, never>;
interface Notes { read(): string; save(value: string): Promise<void> }
const notes = defineDataContract<Notes>({ id: 'typed-notes', version: 1 });
const wrong = defineDataContract<{ count: number }>({ id: 'wrong-shape', version: 1 });
const implementation: Notes = { read: () => '', save: async (_value: string) => {} };

const provided = defineFeatureModule<FeatureType.Data, Empty, { notes: Notes }>({
  id: 'provider', kind: FeatureType.Data, title: 'Provider', description: 'Typed notes provider.',
  contract: { inputs: {}, exports: { notes: 'Notes capability.' } },
  data: { provides: { notes: dataPort(notes, ['read', 'write']) } },
  load: async () => () => ({ notes: implementation }),
});
const typed: FeatureModule<FeatureType.Data, Empty, { notes: Notes }> = provided;
void typed;

defineFeatureModule<FeatureType.Feature, { notes: Notes }, { read(): string }>({
  id: 'consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Typed notes consumer.',
  contract: { inputs: { notes: 'Notes capability.' }, exports: { read: 'Read a title.' } },
  data: { requires: { notes: dataPort(notes, ['read']) } },
  load: async () => inputs => ({ read: () => inputs.notes.read() }),
});

type ProviderDeclaration = Parameters<typeof defineFeatureModule<FeatureType.Data, Empty, { notes: Notes }>>[0];
type ConsumerDeclaration = Parameters<typeof defineFeatureModule<FeatureType.Feature, { notes: Notes }, Empty>>[0];

// @ts-expect-error Data modules require their provided data declaration.
const missingData: ProviderDeclaration = {
  id: 'missing-data', kind: FeatureType.Data, title: 'Missing', description: 'Missing data declaration.',
  contract: { inputs: {}, exports: { notes: 'Notes.' } }, load: async () => () => ({ notes: implementation }),
};
void missingData;

declare const validProvider: ProviderDeclaration;
const badProvider: ProviderDeclaration = {
  ...validProvider,
  // @ts-expect-error The provided data contract must match the export's value type.
  data: { provides: { notes: dataPort(wrong, ['read']) } },
};
void badProvider;

type ReadOnlyProviderDeclaration = Parameters<typeof defineFeatureModule<FeatureType.Data, Empty, { notes: Pick<Notes, 'read'> }>>[0];
declare const readOnlyProvider: ReadOnlyProviderDeclaration;
const weakenedProvider: ReadOnlyProviderDeclaration = {
  ...readOnlyProvider,
  // @ts-expect-error A provider cannot advertise the full Notes contract while exporting only its read subset.
  data: { provides: { notes: dataPort(notes, ['read']) } },
};
void weakenedProvider;

declare const validConsumer: ConsumerDeclaration;
const badConsumer: ConsumerDeclaration = {
  ...validConsumer,
  // @ts-expect-error The required data contract must match the input's value type.
  data: { requires: { notes: dataPort(wrong, ['read']) } },
};
void badConsumer;
const inventedInput: ConsumerDeclaration = {
  ...validConsumer,
  // @ts-expect-error Data requirements name actual typed input ports.
  data: { requires: { invented: dataPort(notes, ['read']) } },
};
void inventedInput;
const providerOnFeature: ConsumerDeclaration = {
  ...validConsumer,
  // @ts-expect-error Ordinary features consume data; only Data modules provide it.
  data: { provides: { notes: dataPort(notes, ['read']) } },
};
void providerOnFeature;
