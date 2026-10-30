import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

// A checkout's scripts/dev/dev.sh that records each command it gets in the calls file, and prints
// the given token for `dev.sh token`.
export function createStubDevScript(checkout: string, calls: string, token: string): void {
  mkdirSync(join(checkout, 'scripts', 'dev'), { recursive: true });

  writeFileSync(
    join(checkout, 'scripts', 'dev', 'dev.sh'),
    [
      '#!/bin/sh',
      `echo "dev.sh $1" >> ${formatShellWord(calls)}`,
      `[ "$1" = token ] && echo ${formatShellWord(token)}`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}
