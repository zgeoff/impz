import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

export function createStubRepoScript(
  scripts: string,
  name: string,
  calls: string,
  body = '',
): string {
  const file = join(scripts, name);

  writeFileSync(
    file,
    `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>${formatShellWord(calls)}\n${body}\n`,
  );

  chmodSync(file, 0o755);

  return file;
}
