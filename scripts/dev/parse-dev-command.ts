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
