// Compile-time contract for registered commands (checked by `pnpm typecheck`).
import type { ModuleContext } from '../src/module.js';

declare const scope: ModuleContext;

interface Result { readonly ok: boolean }
interface DomainCommands {
  add(title: string): Promise<Result>;
  move(id: string, position: number): Promise<void>;
}
declare const implementation: DomainCommands;

// Interface types register without an index signature and keep their exact type.
const commands: DomainCommands = scope.commands(implementation);
const added: Promise<Result> = commands.add('title');
void added;

// Inferred object literals keep argument and result types.
const inferred = scope.commands({
  async rename(id: string, title: string) { return { id, title }; },
});
const renamed: Promise<{ id: string; title: string }> = inferred.rename('1', 'Title');
void renamed;

// @ts-expect-error Wrong argument type.
void commands.add(42);
// @ts-expect-error Missing argument.
void inferred.rename('1');
// @ts-expect-error Unknown command.
void commands.remove('1');
// @ts-expect-error Results keep their inferred type.
const wrongResult: Promise<string> = commands.add('title');
void wrongResult;
// @ts-expect-error Commands must be asynchronous so refusal and outcomes are observable.
scope.commands({ now: () => 1 });
// @ts-expect-error Non-function values are not commands.
scope.commands({ label: 'not a command' });

// Results are native promises of the awaited value; extra thenable members are not promised.
declare const cancellable: Promise<number> & { cancel(): void };
const wrapped = scope.commands({ run: () => cancellable });
const settled: Promise<number> = wrapped.run();
void settled;
// @ts-expect-error The wrapper returns an ordinary Promise without custom members.
wrapped.run().cancel();

// Receivers keep their declared type.
const withReceiver = scope.commands({ async read(this: { readonly prefix: string }, value: string) { return this.prefix + value; } });
void withReceiver.read.call({ prefix: '>' }, 'x');
// @ts-expect-error The receiver type is preserved.
void withReceiver.read.call({ other: true }, 'x');

// Known limitation: the mapped command type uses Parameters/ReturnType, so it
// keeps only the last overload and erases type parameters. Generic commands
// return Promise<unknown>; declare concrete signatures for public commands.
const generic = scope.commands({ async identity<T>(value: T) { return value; } });
const erased: Promise<unknown> = generic.identity(1);
void erased;
// @ts-expect-error A generic argument/result relationship is not preserved.
const related: Promise<number> = generic.identity(1);
void related;
interface Overloaded {
  find(id: string): Promise<string>;
  find(id: number): Promise<number>;
}
declare const overloaded: Overloaded;
const lastOverload = scope.commands(overloaded);
const byNumber: Promise<number> = lastOverload.find(1);
void byNumber;
// @ts-expect-error Only the last overload is kept.
void lastOverload.find('id');
