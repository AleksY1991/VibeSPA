const modifiers = ['ctrl', 'alt', 'shift', 'meta'] as const;
const aliases: Readonly<Record<string, string>> = {
  control: 'ctrl', cmd: 'meta', command: 'meta', option: 'alt',
  esc: 'escape', ' ': 'space', spacebar: 'space', '+': 'plus',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};

/** A platform-neutral combination such as ctrl+shift+k or meta+enter. */
export function normalizeKey(combination: string): string {
  const parts = combination === ' ' || combination === '+'
    ? [aliases[combination]!]
    : combination.toLowerCase().split('+').map(part => part.trim()).map(part => aliases[part] ?? part);
  const keys = parts.filter(part => !modifiers.some(modifier => modifier === part));
  if (keys.length !== 1 || !keys[0]) throw new Error(`Invalid key combination: ${combination}`);
  return [...modifiers.filter(modifier => parts.includes(modifier)), keys[0]].join('+');
}
