import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createStubKsmExec(directory: string) {
  const path = join(directory, 'ksm-exec');
  const recorded = join(directory, 'ksm-exec.argv');

  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\nexit 1\n`, { mode: 0o755 });

  return {
    path,
    readArgv: (): string[] => readFileSync(recorded, 'utf8').trimEnd().split('\n'),
  };
}
