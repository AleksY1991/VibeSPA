import type { Readable } from '@vibespa/contracts';
import type { HistoryState, Intention, FocusView } from '../../contracts/focus';
import type { TitlePolicy } from '../title-policy/contract';

export type IntentionWrite =
  | { readonly kind: 'put'; readonly document: Intention }
  | { readonly kind: 'delete'; readonly id: string };

export interface IntentionRepository {
  readonly pending: Readable<readonly Readonly<Intention>[]>;
  readonly completed: Readable<readonly Readonly<Intention>[]>;
  readonly history: Readable<HistoryState>;
  write(gesture: {
    readonly gestureId: string;
    readonly label: string;
    readonly writes: readonly IntentionWrite[];
  }): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface FocusInputs {
  readonly repository: IntentionRepository;
  readonly titles: TitlePolicy;
  readonly createId: () => string;
}

export type Focus = FocusView;
