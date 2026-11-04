import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from './format-shell-word';

interface StubSlowCommand {
  readonly bin: string;
  readonly log: string;

  // A call also ends once the log is gone, so a call that outlives its test's directory never
  // waits on.
  readonly release: string;
}

export function createStubSlowCommand(directory: string, name: string): StubSlowCommand {
  const bin = join(directory, 'bin');
  const log = join(directory, `${name}.log`);
  const release = join(directory, `${name}.release`);
  const file = join(bin, name);

  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');

  writeFileSync(
    file,
    [
      '#!/bin/bash',
      `printf '%s\\n' "${name} $* started" >>${formatShellWord(log)}`,
      `until [ -e ${formatShellWord(release)} ] || [ ! -e ${formatShellWord(log)} ]; do sleep 0.01; done`,
      `[ ! -e ${formatShellWord(log)} ] || printf '%s\\n' "${name} $* finished" >>${formatShellWord(log)}`,
      '',
    ].join('\n'),
  );

  chmodSync(file, 0o755);

  return { bin, log, release };
}
