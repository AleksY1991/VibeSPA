import type { IntentionRepository } from '../focus/contract';

export interface LocalStorageInputs {
  readonly name: string;
  readonly maximumTitleLength: number;
}

export interface LocalStorage {
  readonly repository: IntentionRepository;
}
