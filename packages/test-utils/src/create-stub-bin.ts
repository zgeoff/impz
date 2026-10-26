import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

export interface StubBin {
  readonly bin: string;
  readonly calls: string;
}

export function createStubBin(directory: string, name: string, script = ''): StubBin {
  const bin = join(directory, 'bin');
  const calls = join(directory, 'calls');
  const file = join(bin, name);

  mkdirSync(bin, { recursive: true });

  if (!existsSync(calls)) {
    writeFileSync(calls, '');
  }

  writeFileSync(
    file,
    `#!/bin/bash\nSTUB_CALLS=${formatShellWord(calls)}\nprintf '%s\\n' "${name} $*" >>"$STUB_CALLS"\n${script}\n`,
  );

  chmodSync(file, 0o755);

  return { bin, calls };
}
