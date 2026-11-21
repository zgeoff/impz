import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';
import { createStubBin } from '@zgeoff/testing/bin';
import type { StubBin, StubBinOptions } from '@zgeoff/testing/bin';

// Writes `<name>.sh` for a program that runs the script by its path. Bun runs a file named .sh as
// a Bun shell script, which a kit stand-in is not, so the .sh file execs a kit stand-in named
// `<name>`, and the calls it records carry that name. The `.sh` file goes in `scripts` when given.
export function createStubShellScript(
  directory: string,
  name: string,
  options?: StubBinOptions,
  scripts: string = directory,
): StubBin {
  const stub = createStubBin(directory, name, options);
  const path = join(scripts, `${name}.sh`);

  mkdirSync(scripts, { recursive: true });
  writeFileSync(path, `#!/bin/bash\nexec ${formatShellWord(stub.path)} "$@"\n`);
  chmodSync(path, 0o755);

  return stub;
}
