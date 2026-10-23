import { parseArgs } from 'node:util';
import * as z from 'zod';

const DevCommandSchema = z.enum([
  'up',
  'down',
  'reboot',
  'logs',
  'restart',
  'shell',
  'token',
  'prune',
]);

export type DevCommand = z.infer<typeof DevCommandSchema>;

export const DEV_USAGE = `usage: scripts/dev/dev.sh ${DevCommandSchema.options.join('|')}`;

// As the bash script's case "$1" did, the first word is the command, and the words after it are
// ignored; a flag in its place names no command.
export function parseDevCommand(argv: readonly string[]): DevCommand | null {
  const parsed = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const [first] = parsed.tokens;

  if (first?.kind !== 'positional') {
    return null;
  }

  const command = DevCommandSchema.safeParse(first.value);

  return command.success ? command.data : null;
}
