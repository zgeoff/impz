import { chmodSync } from 'node:fs';
import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';
import { createStubBin } from '@zgeoff/testing/bin';
import type { StubBin } from '@zgeoff/testing/bin';

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

    chmodSync(stub.path, 0o644);

    return formatShellWord(stub.path);
  });

  return createStubBin(directory, 'apt-get', {
    script: `#!/bin/bash\n[ "$1" = install ] && ${formatShellWord(chmodPath)} +x ${files.join(' ')}\nexit 0`,
  });
}
