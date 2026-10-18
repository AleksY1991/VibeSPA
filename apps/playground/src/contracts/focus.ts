import type { Readable } from '@vibespa/contracts';

export interface Intention {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export type CommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface FocusCommands {
  add(title: string): Promise<CommandResult>;
  toggle(id: string): Promise<CommandResult>;
  remove(id: string): Promise<CommandResult>;
  completePending(): Promise<CommandResult>;
  undo(): Promise<CommandResult>;
  redo(): Promise<CommandResult>;
}

export interface FocusView {
  readonly pending: Readable<readonly Readonly<Intention>[]>;
  readonly completed: Readable<readonly Readonly<Intention>[]>;
  readonly history: Readable<HistoryState>;
  readonly commands: FocusCommands;
}
