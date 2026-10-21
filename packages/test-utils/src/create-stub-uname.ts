import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StubUnameOptions {
  readonly bin: string;
  readonly system: string;
  readonly machine: string;
}

export function createStubUname(options: StubUnameOptions): void {
  writeFileSync(
    join(options.bin, 'uname'),
    [
      '#!/bin/sh',
      `[ "$1" = -s ] && echo '${options.system}' && exit 0`,
      `[ "$1" = -m ] && echo '${options.machine}' && exit 0`,
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}
