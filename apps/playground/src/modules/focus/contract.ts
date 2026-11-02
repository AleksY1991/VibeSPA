import type { FocusView } from '../../contracts/focus';
import type { IntentionsData } from '../intentions-data/contract';
import type { TitlePolicy } from '../title-policy/contract';

export interface FocusInputs {
  /** Typed data capabilities; backend policy stays behind the Data module. */
  readonly data: IntentionsData;
  readonly titles: TitlePolicy;
  readonly createId: () => string;
}

export type Focus = FocusView;
