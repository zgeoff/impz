import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import type { StubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

export interface StubProcessTableOptions {
  // the state ps -C <name> -o stat= prints for each process, until pkill -x <name> ends it
  readonly processes: Readonly<Record<string, string>>;

  // pkill still ends the process but exits 1, as when the signal races its exit
  readonly pkillFails?: boolean;
}

export function createStubProcessTable(
  directory: string,
  options: Readonly<StubProcessTableOptions>,
): StubBin {
  const table = join(directory, 'processes');

  mkdirSync(table, { recursive: true });

  for (const [name, state] of Object.entries(options.processes)) {
    writeFileSync(join(table, name), `${state}\n`);
  }

  createStubBin(
    directory,
    'ps',
    `[ "$1" = -C ] || exit 1
command -p cat ${formatShellWord(table)}/"$2" 2>/dev/null`,
  );

  return createStubBin(
    directory,
    'pkill',
    `[ "$1" = -x ] || exit 1
rm -f ${formatShellWord(table)}/"$2"
${options.pkillFails === true ? 'exit 1' : ''}`,
  );
}
