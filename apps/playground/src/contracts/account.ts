import type { Accessor } from 'solid-js';
import type { CommandResult } from './focus';

export interface AccountIdentity {
  readonly userId: string;
  readonly email: string | null;
}

export type LinkRequestState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'sending' }
  | { readonly phase: 'sent'; readonly email: string }
  | { readonly phase: 'failed'; readonly message: string };

export interface AccountCommands {
  requestLink(email: string): Promise<CommandResult>;
  signOut(): Promise<CommandResult>;
}

export interface AccountView {
  /** The signed-in account for this generation, or null when signed out. */
  readonly identity: AccountIdentity | null;
  readonly link: Accessor<LinkRequestState>;
  readonly commands: AccountCommands;
}

export interface SyncStatus {
  /** Running describes the replication lifecycle, not network connectivity. */
  readonly phase: 'starting' | 'running' | 'stopped';
  readonly active: boolean;
  readonly initialSyncComplete: boolean;
  readonly error: string | null;
}

/** Local values the server or durable row replaced since the last dismissal. */
export interface ReplacementNotice {
  readonly count: number;
}

export interface SyncView {
  readonly status: Accessor<SyncStatus>;
  readonly replaced: Accessor<ReplacementNotice | null>;
  readonly commands: { dismiss(): Promise<CommandResult> };
}
