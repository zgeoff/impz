import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

// A tree's pack script writes its tarball under build/npm/ of the directory it runs in, and prints
// the tarball's absolute path as its only output.
export function createStubPackScript(folder: string, name: string, tarball: string): void {
  const relative = formatShellWord(`build/npm/${tarball}`);

  writeFileSync(
    join(folder, name),
    [
      '#!/bin/sh',
      'mkdir -p build/npm',
      `echo ${formatShellWord(tarball)} > ${relative}`,
      `echo "$PWD/"${relative}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}
