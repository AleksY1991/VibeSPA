// Checked by the repository typecheck without running any application or backend.
import { dataPort, defineDataContract } from '../src/data.js';
import type { DataContract, DataDeclarations, DataPorts, ModuleDataDeclarations } from '../src/data.js';

interface TaskRead { read(): string }
interface TaskWrite { write(value: string): Promise<void> }
const read = defineDataContract<TaskRead>({ id: 'task.read', version: 0 });
const write = defineDataContract<TaskWrite>({ id: 'task.write', version: 0 });

const declarations: ModuleDataDeclarations<{ readonly tasks: TaskRead }, { readonly commands: TaskWrite }> = {
  requires: { tasks: dataPort(read, ['read']) },
  provides: { commands: dataPort(write, ['write']) },
};
const neutral: DataDeclarations = declarations;
void neutral;

// Generic and index-signature module shapes retain optional port declarations.
function runtimeDeclarations<Inputs extends object, Exports extends object>(value: ModuleDataDeclarations<Inputs, Exports>): DataDeclarations {
  return value;
}
declare const empty: ModuleDataDeclarations<Record<string, never>, Record<string, never>>;
declare const optional: ModuleDataDeclarations<{ readonly tasks?: TaskRead }, { readonly commands?: TaskWrite }>;
const emptyRuntime: DataDeclarations = runtimeDeclarations(empty);
const optionalRuntime: DataDeclarations = runtimeDeclarations(optional);
void emptyRuntime;
void optionalRuntime;

const wrongInput: DataPorts<{ readonly tasks: TaskRead }> = {
  // @ts-expect-error A write contract does not implement the requested read value.
  tasks: dataPort(write, ['read']),
};
void wrongInput;
const wrongOutput: DataPorts<{ readonly commands: TaskWrite }> = {
  // @ts-expect-error Provider exports must implement the contract value type.
  commands: dataPort(read, ['write']),
};
void wrongOutput;
const unknownPort: DataPorts<{ readonly tasks: TaskRead }> = {
  // @ts-expect-error A declaration cannot name an input that does not exist.
  missing: dataPort(read, ['read']),
};
void unknownPort;

// A provider cannot advertise a full API while exporting only its read subset.
interface FullTasks extends TaskRead, TaskWrite {}
const full = defineDataContract<FullTasks>({ id: 'tasks.full', version: 0 });
// @ts-expect-error Contracts are invariant: a narrower export needs its own public view contract.
const overstated: DataContract<TaskRead> = full;
void overstated;
const overstatedPort: DataPorts<{ readonly tasks: TaskRead }> = {
  // @ts-expect-error Declaring read/write capabilities cannot add a missing write implementation.
  tasks: dataPort(full, ['read', 'write']),
};
void overstatedPort;
