import { defineDataContract } from '@vibespa/core';
import type { DomainAdapter, DomainView, DomainWrite, LocalReceipt } from '@vibespa/solid/domain';
import type { Intention } from '../../contracts/focus';
import type { TitlePolicy } from '../title-policy/contract';

export interface IntentionsDataCommands {
  commit(gesture: {
    readonly gestureId: string;
    readonly label: string;
    readonly writes: readonly DomainWrite<Intention>[];
  }): Promise<LocalReceipt>;
  undo(): Promise<LocalReceipt | undefined>;
  redo(): Promise<LocalReceipt | undefined>;
  retry(): Promise<void>;
  keepLocal(): Promise<void>;
}

export interface IntentionsData {
  readonly view: DomainView<Intention>;
  readonly commands: IntentionsDataCommands;
}

export interface IntentionsDataInputs {
  readonly adapter: DomainAdapter<Intention> | undefined;
  readonly generation: string;
  readonly titles: TitlePolicy;
}

export interface IntentionsDataExports {
  readonly data: IntentionsData;
}

/** A shared declaration, never a database or live record collection. */
export const intentionsData = defineDataContract<IntentionsData>({
  id: 'intentions',
  version: 0,
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      done: { type: 'boolean' },
    },
    required: ['id', 'title', 'done'],
    additionalProperties: false,
  },
});

export const intentionsCapabilities = ['read', 'write', 'live', 'local-apply'] as const;
