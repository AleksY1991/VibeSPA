import { createSource } from '@vibespa/core/readable';
import type { ModuleContext } from '@vibespa/core/module';
import { moduleAccessor } from '@vibespa/solid/module';
import type { LinkRequestState } from '../../../contracts/account';
import type { CommandResult } from '../../../contracts/focus';
import type { AccountExports, AccountInputs } from '../contract';

// Deliberately simple: the auth provider performs the real address check.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const message = (error: unknown): string => error instanceof Error && error.message ? error.message : 'Unable to reach Supabase.';

export function createAccount(inputs: AccountInputs, scope: ModuleContext): AccountExports {
  const link = createSource<LinkRequestState>({ phase: 'idle' });
  const commands = scope.commands({
    async requestLink(email: string): Promise<CommandResult> {
      const address = email.trim().toLowerCase();
      if (!EMAIL.test(address)) {
        const failure = 'Enter a valid email address.';
        link.set({ phase: 'failed', message: failure });
        return { ok: false, message: failure };
      }
      link.set({ phase: 'sending' });
      try {
        await inputs.auth.requestLink(address);
        if (!scope.signal.aborted) link.set({ phase: 'sent', email: address });
        return { ok: true };
      } catch (error: unknown) {
        const failure = message(error);
        if (!scope.signal.aborted) link.set({ phase: 'failed', message: failure });
        return { ok: false, message: failure };
      }
    },
    async signOut(): Promise<CommandResult> {
      try {
        await inputs.auth.signOut();
        return { ok: true };
      } catch (error: unknown) {
        return { ok: false, message: message(error) };
      }
    },
  });
  return {
    account: {
      identity: inputs.identity,
      link: moduleAccessor(scope, link.source, { name: 'account.link' }),
      commands,
    },
  };
}
