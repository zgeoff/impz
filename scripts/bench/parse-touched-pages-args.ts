import { parseArgs } from 'node:util';
import { parseSize } from '@impz/cli/parse-size';
import type { TouchedPagesOptions } from './run-touched-pages';

const USAGE =
  'usage: bun scripts/bench/measure-touched-pages.ts [--memory <size>] [--write-mib <n>]';

export function parseTouchedPagesArgs(argv: readonly string[]): TouchedPagesOptions | string {
  let values: { readonly memory: string; readonly 'write-mib': string };

  try {
    values = parseArgs({
      args: [...argv],
      options: {
        memory: { type: 'string', default: '1g' },
        'write-mib': { type: 'string', default: '128' },
      },
    }).values;
  } catch {
    return USAGE;
  }

  const writeMib = Number(values['write-mib']);

  if (!Number.isInteger(writeMib) || writeMib < 1) {
    return USAGE;
  }

  try {
    return { memory: values.memory, memoryMib: parseSize(values.memory), writeMib };
  } catch (error) {
    return error instanceof Error ? `${error.message}\n${USAGE}` : USAGE;
  }
}
