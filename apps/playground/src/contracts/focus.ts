import type { Accessor } from 'solid-js';

export interface Intention {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface DeliveryState {
  readonly phase: 'memory' | 'loading' | 'saving' | 'idle' | 'failed' | 'closed';
  readonly pending: number;
  readonly error: string | null;
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
  retry(): Promise<CommandResult>;
  keepLocal(): Promise<CommandResult>;
}

export interface FocusView {
  /** Tracked reads: call them inside JSX or a Solid computation. */
  readonly pending: Accessor<readonly Readonly<Intention>[]>;
  readonly completed: Accessor<readonly Readonly<Intention>[]>;
  readonly history: Accessor<HistoryState>;
  readonly delivery: Accessor<DeliveryState>;
  readonly commands: FocusCommands;
}
