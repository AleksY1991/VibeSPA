import type { Scope } from '@vibespa/contracts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { FeatureType, defineFeatureModule, startModule } from '../src/module.js';
import type { FeatureModule } from '../src/module.js';
import { createScope } from '../src/scope.js';

interface GreetingInputs {
  prefix: string;
  maximumLength?: number;
}

interface GreetingExports {
  greet(name: string): string;
}

const metadata = {
  id: 'greeting',
  kind: FeatureType.Policy,
  title: 'Greeting policy',
  description: 'Formats greetings with an explicitly supplied prefix.',
  contract: {
    inputs: { prefix: 'Prefix before the name.', maximumLength: 'Optional maximum greeting length.' },
    exports: { greet: 'Format a greeting for the supplied name.' },
  },
};

describe('feature module contracts', () => {
  it('infers its enum kind and typed boundary without running the lazy factory', async () => {
    const create = vi.fn((inputs: GreetingInputs, _scope: Scope): GreetingExports => ({
      greet: (name: string) => `${inputs.prefix}, ${name}`.slice(0, inputs.maximumLength),
    }));
    const load = vi.fn(async () => create);
    const definition = defineFeatureModule({ ...metadata, kind: FeatureType.Policy, load });

    expectTypeOf(definition.kind).toEqualTypeOf<FeatureType.Policy>();
    expectTypeOf(definition).toMatchTypeOf<FeatureModule<FeatureType.Policy, GreetingInputs, GreetingExports>>();
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    const owner = createScope();
    const greeting = await startModule(definition, { prefix: 'Hello' }, owner);
    expectTypeOf(greeting).toEqualTypeOf<GreetingExports>();
    expect(greeting.greet('Ada')).toBe('Hello, Ada');
    expect(load).toHaveBeenCalledOnce();
    await owner.dispose();
  });

  it('captures frozen metadata independently of the caller objects', () => {
    const inputDescriptions = { prefix: 'Prefix before the name.', maximumLength: 'Optional maximum greeting length.' };
    const exportDescriptions = { greet: 'Format a greeting for the supplied name.' };
    const contract = { inputs: inputDescriptions, exports: exportDescriptions };
    const supplied = {
      ...metadata,
      contract,
      load: async () => (inputs: GreetingInputs): GreetingExports => ({ greet: name => `${inputs.prefix}, ${name}` }),
    };
    const definition = defineFeatureModule(supplied);
    supplied.title = 'Changed title';
    supplied.description = 'Changed description';
    inputDescriptions.prefix = 'Changed input';
    exportDescriptions.greet = 'Changed export';
    contract.inputs = { prefix: 'Replaced input', maximumLength: 'Replaced optional input' };

    expect(definition.title).toBe(metadata.title);
    expect(definition.description).toBe(metadata.description);
    expect(definition.contract.inputs.prefix).toBe('Prefix before the name.');
    expect(definition.contract.exports.greet).toBe('Format a greeting for the supplied name.');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.contract)).toBe(true);
    expect(Object.isFrozen(definition.contract.inputs)).toBe(true);
    expect(Object.isFrozen(definition.contract.exports)).toBe(true);
  });

  it.each(['id', 'title', 'description'] as const)('rejects an empty %s without loading', field => {
    const load = vi.fn(async () => (_inputs: GreetingInputs): GreetingExports => ({ greet: name => name }));
    expect(() => defineFeatureModule({ ...metadata, [field]: '  ', load })).toThrow('must not be empty');
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['inputs', 'exports'] as const)('rejects blank %s port descriptions without loading', field => {
    const load = vi.fn(async () => (_inputs: GreetingInputs): GreetingExports => ({ greet: name => name }));
    const contract = {
      inputs: { ...metadata.contract.inputs },
      exports: { ...metadata.contract.exports },
    };
    if (field === 'inputs') contract.inputs.prefix = ' ';
    else contract.exports.greet = ' ';
    expect(() => defineFeatureModule({ ...metadata, contract, load })).toThrow('description must not be empty');
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects categories outside the enumerable vocabulary', () => {
    const load = vi.fn(async () => (_inputs: GreetingInputs): GreetingExports => ({ greet: name => name }));
    expect(() => defineFeatureModule({ ...metadata, kind: 'custom' as FeatureType, load })).toThrow('Unknown feature module kind');
    expect(load).not.toHaveBeenCalled();
  });
});

// Compile-only examples protect the boundary inferred from a lazy factory.
async function verifyTypeContracts() {
  const definition = defineFeatureModule({
    ...metadata,
    kind: FeatureType.Policy,
    load: async () => (inputs: GreetingInputs): GreetingExports => ({ greet: name => `${inputs.prefix}, ${name}` }),
  });
  const owner = createScope();
  // @ts-expect-error Inputs retain the factory's prefix type.
  await startModule(definition, { prefix: 123 }, owner);
  // @ts-expect-error A policy cannot be assigned to the view category.
  const _view: FeatureModule<FeatureType.View, GreetingInputs, GreetingExports> = definition;
  // @ts-expect-error The category is constrained to the finite enum.
  type _UnknownKind = FeatureModule<'custom'>;

  // @ts-expect-error Partial type arguments must not erase the inferred export boundary.
  defineFeatureModule<FeatureType.Policy>({
    ...metadata,
    contract: { inputs: {}, exports: {} },
    load: async () => (_inputs: object) => ({ undocumented: 'value' }),
  });

  defineFeatureModule({
    ...metadata,
    contract: {
      // @ts-expect-error Even optional inputs must describe their capability.
      inputs: { prefix: 'Prefix before the name.' },
      exports: metadata.contract.exports,
    },
    load: definition.load,
  });
  defineFeatureModule({
    ...metadata,
    contract: {
      inputs: metadata.contract.inputs,
      // @ts-expect-error Every exported capability requires a description.
      exports: {},
    },
    load: definition.load,
  });
  defineFeatureModule({
    ...metadata,
    contract: {
      inputs: metadata.contract.inputs,
      exports: {
        greet: 'Format a greeting.',
        // @ts-expect-error Metadata cannot invent a capability absent from the factory.
        save: 'Save a greeting.',
      },
    },
    load: definition.load,
  });
}
void verifyTypeContracts;
