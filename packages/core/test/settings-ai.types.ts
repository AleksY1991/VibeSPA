import { aiContributionContract, defineAiTool } from '../src/ai.js';
import { contributionPort } from '../src/contributions.js';
import type { ContributionPort } from '../src/contributions.js';
import { constantReadable } from '../src/readable.js';
import { settingsContributionContract } from '../src/settings.js';
import type { SettingsEntry, SettingsSection } from '../src/settings.js';

const tool = defineAiTool({
  id: 'typed-double', title: 'Double', description: 'A typed AI tool.', inputSchema: { type: 'number' },
  parseInput(value: unknown): number {
    if (typeof value !== 'number') throw new Error('Expected number.');
    return value;
  },
  parseOutput(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Expected string.');
    return value;
  },
  execute: async (value: number) => String(value * 2),
});
const result: Promise<string> = tool.run(2, new AbortController().signal);
void result;
// @ts-expect-error Typed tool calls preserve their input type.
void tool.run('2', new AbortController().signal);
// @ts-expect-error Typed tool calls preserve their output type.
const wrongResult: Promise<number> = tool.run(2, new AbortController().signal);
void wrongResult;

const validAction: SettingsEntry = {
  id: 'logout', kind: 'action', label: constantReadable('Sign out'), run: async () => {},
};
void validAction;
// @ts-expect-error Action entries require their owned operation.
const invalidAction: SettingsEntry = { id: 'logout', kind: 'action', label: constantReadable('Sign out') };
void invalidAction;
// @ts-expect-error Settings labels are neutral reactive reads.
const invalidLabel: SettingsEntry = { id: 'role', kind: 'value', label: 'Role', value: constantReadable('admin') };
void invalidLabel;
const settingsPort: ContributionPort<SettingsSection> = contributionPort(settingsContributionContract);
void settingsPort;
// @ts-expect-error AI contributions cannot satisfy the Settings contract.
const wrongPort: ContributionPort<SettingsSection> = contributionPort(aiContributionContract);
void wrongPort;
