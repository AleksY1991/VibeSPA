import path from 'node:path';

const normalize = value => value.replaceAll('\\', '/').replace(/\/$/, '');
const windows = value => /^[a-z]:\/|^\/\//i.test(value);
const absolute = value => /^(?:[a-z]:\/|\/)/i.test(value);
const join = (base, ...parts) => normalize((windows(base) ? path.win32 : path.posix).resolve(base, ...parts));
const identity = (value, root) => windows(root) ? value.toLowerCase() : value;

export const defaults = {
  aliases: {
    '@/': 'apps/playground/src/',
    '@vibespa/contracts': 'packages/contracts/src',
    '@vibespa/core': 'packages/core/src',
    '@vibespa/local-first': 'packages/local-first/src',
    '@vibespa/supabase': 'packages/supabase/src',
    '@vibespa/solid': 'packages/solid/src',
    '@vibespa/settings': 'packages/settings/src',
    '@vibespa/interaction': 'packages/interaction/src',
  },
  moduleRoots: ['src/modules', 'apps/*/src/modules', 'packages/*/src/modules'],
  packageRoots: ['packages'],
  domainRoots: ['src/modules', 'apps/*/src/modules', 'packages/core/src', 'packages/contracts/src', 'packages/local-first/src', 'packages/settings/src', 'packages/interaction/src'],
  uiRoots: ['src/ui', 'apps/*/src/ui'],
  contractRoots: ['src/contracts', 'apps/*/src/contracts', 'packages/contracts/src'],
  uiAdapters: [],
  allowedUiImports: ['@vibespa/contracts', '@vibespa/solid'],
  forbiddenUiImports: ['@vibespa/core', '@vibespa/local-first', '@vibespa/supabase', '@vibespa/settings', '@vibespa/interaction', 'rxdb', '@supabase/supabase-js'],
};

function glob(pattern) {
  let result = '';
  const input = normalize(pattern).replace(/^\.\//, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '*') {
      if (input[index + 1] === '*') {
        index += 1;
        if (input[index + 1] === '/') { result += '(?:.*/)?'; index += 1; }
        else result += '.*';
      } else result += '[^/]*';
    } else if (char === '?') result += '[^/]';
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return result;
}

export function matches(filename, patterns) {
  return patterns.some(pattern => new RegExp(`^${glob(pattern)}(?:/|$)`).test(filename));
}

export function sourceValue(node) {
  if (node?.type === 'Literal' || node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

export function memberName(node) {
  return node?.type === 'MemberExpression'
    ? node.computed ? sourceValue(node.property) : node.property.name
    : undefined;
}

export function importVisitors(inspect) {
  return {
    ImportDeclaration(node) { inspect(node, sourceValue(node.source)); },
    ExportNamedDeclaration(node) { if (node.source) inspect(node, sourceValue(node.source)); },
    ExportAllDeclaration(node) { inspect(node, sourceValue(node.source)); },
    ImportExpression(node) { inspect(node, sourceValue(node.source)); },
    TSImportType(node) { inspect(node, sourceValue(node.source ?? node.argument?.literal ?? node.argument)); },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === 'TSExternalModuleReference') inspect(node, sourceValue(node.moduleReference.expression));
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') inspect(node, sourceValue(node.arguments[0]));
    },
  };
}

export function paths(context, options = {}) {
  const root = normalize(options.rootDir ?? context.cwd ?? process.cwd());
  const filename = normalize(context.filename);
  const full = identity(absolute(filename) ? filename : join(root, filename), root);
  const rootId = identity(root, root);
  const relative = value => {
    const id = identity(normalize(value), root);
    return id.startsWith(`${rootId}/`) ? id.slice(rootId.length + 1) : id;
  };
  const aliases = Object.entries({ ...defaults.aliases, ...options.aliases })
    .sort(([left], [right]) => right.length - left.length);
  function resolve(specifier) {
    if (typeof specifier !== 'string') return undefined;
    if (specifier.startsWith('.')) return relative(join(path.posix.dirname(full), specifier));
    if (absolute(specifier)) return relative(specifier);
    for (const [alias, target] of aliases) {
      if (specifier === alias || specifier.startsWith(alias.endsWith('/') ? alias : `${alias}/`)) {
        const suffix = specifier.slice(alias.length).replace(/^\//, '');
        return relative(join(root, target, suffix));
      }
    }
    return specifier;
  }
  function owner(target) {
    let found;
    for (const roots of [options.packageRoots ?? defaults.packageRoots, options.moduleRoots ?? defaults.moduleRoots]) {
      for (const base of roots) {
        const match = target.match(new RegExp(`^(${glob(base)}/[^/]+)(?:/|$)`));
        if (match && (!found || match[1].length > found.length)) found = match[1];
      }
    }
    // Nested micro-modules keep their own privacy even within an outer module.
    if (found) {
      const nested = /\/modules\/[^/]+(?=\/|$)/g;
      for (const match of target.matchAll(nested)) {
        const candidate = target.slice(0, match.index + match[0].length);
        if (candidate.length > found.length) found = candidate;
      }
    }
    return found;
  }
  return { filename: relative(full), resolve, owner };
}

export const commonProperties = {
  rootDir: { type: 'string' },
  aliases: { type: 'object', additionalProperties: { type: 'string' } },
  moduleRoots: { type: 'array', items: { type: 'string' } },
  packageRoots: { type: 'array', items: { type: 'string' } },
};
