import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from './format-shell-word';

interface StubFailingDockerCommand {
  readonly bin: string;
}

export function createStubFailingDockerCommand(
  directory: string,
  subcommand: string,
  realDocker: string,
): StubFailingDockerCommand {
  const bin = join(directory, 'bin');
  const file = join(bin, 'docker');

  mkdirSync(bin, { recursive: true });

  writeFileSync(
    file,
    [
      '#!/bin/bash',
      `if [ "$1" = ${formatShellWord(subcommand)} ]; then`,
      `  echo ${formatShellWord(`stub docker: ${subcommand} fails`)} >&2`,
      '  exit 1',
      'fi',
      `exec ${formatShellWord(realDocker)} "$@"`,
      '',
    ].join('\n'),
  );

  chmodSync(file, 0o755);

  return { bin };
}
