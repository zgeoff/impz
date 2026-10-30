import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import type { StubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

// A command lookup skips a file without its exec bit, so each tool waits in the stubs' folder
// until apt-get install sets the bit. The stub names chmod by its full path, because a test's
// PATH may hold only the stubs' folder.
export function createStubAptGet(directory: string, tools: readonly string[]): StubBin {
  const chmodPath = Bun.which('chmod');

  if (chmodPath === null) {
    throw new Error('createStubAptGet needs chmod on the host');
  }

  const files = tools.map((tool) => {
    const stub = createStubBin(directory, tool);
    const file = join(stub.bin, tool);

    chmodSync(file, 0o644);

    return formatShellWord(file);
  });

  return createStubBin(
    directory,
    'apt-get',
    `[ "$1" = install ] && ${formatShellWord(chmodPath)} +x ${files.join(' ')}\nexit 0`,
  );
}
