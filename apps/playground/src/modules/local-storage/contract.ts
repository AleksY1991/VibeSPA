import type { DomainAdapter } from '@vibespa/solid/domain';
import type { Intention } from '../../contracts/focus';

export interface LocalStorageInputs {
  readonly name: string;
  readonly maximumTitleLength: number;
}

export interface LocalStorage {
  readonly adapter: DomainAdapter<Intention>;
}
