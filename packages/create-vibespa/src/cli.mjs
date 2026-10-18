import { basename, resolve } from 'node:path';
import { createApplication, createModule, resolveTemplateRoot } from './scaffold.mjs';

const help = `VibeSPA · Good vibes. Clear boundaries.

Create an application:
  create-vibespa <directory> [--name app-name]

Add a module to an application:
  create-vibespa module <module-name> [--cwd app-directory]

The destination must be empty. Existing files and symbolic links are refused.`;

function parseOptions(arguments_, allowed) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    const key = separator === -1 ? argument : argument.slice(0, separator);
    if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
    if (options.has(key)) throw new Error(`Option supplied twice: ${key}`);
    const value = separator === -1 ? arguments_[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${key}.`);
    options.set(key, value);
  }
  return { positionals, options };
}

export async function runCli(arguments_, output = console.log) {
  if (arguments_.length === 0 || arguments_.includes('--help') || arguments_.includes('-h')) {
    output(help);
    return;
  }
  if (arguments_[0] === 'module') {
    const { positionals, options } = parseOptions(arguments_.slice(1), ['--cwd']);
    if (positionals.length !== 1) throw new Error('Usage: create-vibespa module <module-name> [--cwd app-directory]');
    const destination = await createModule({
      name: positionals[0],
      application: resolve(options.get('--cwd') ?? process.cwd()),
    });
    output(`Created module at ${destination}.`);
    output('Compose it by importing its definition and supplying its typed inputs.');
    return;
  }

  const { positionals, options } = parseOptions(arguments_, ['--name']);
  if (positionals.length !== 1) throw new Error('Usage: create-vibespa <directory> [--name app-name]');
  const destination = resolve(positionals[0]);
  const name = options.get('--name') ?? basename(destination).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  await createApplication({ destination, name, templateRoot: await resolveTemplateRoot() });
  output(`Created ${name} at ${destination}.`);
  output('In the new directory, run pnpm install, then pnpm dev.');
}
