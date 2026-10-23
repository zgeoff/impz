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

// As the bash script did, only the first word counts, and the words after it are ignored.
export function parseDevCommand(argv: readonly string[]): DevCommand | null {
  const parsed = parseArgs({ args: [...argv], strict: false, allowPositionals: true });
  const command = DevCommandSchema.safeParse(parsed.positionals[0]);

  return command.success ? command.data : null;
}
