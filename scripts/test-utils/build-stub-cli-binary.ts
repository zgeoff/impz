import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubCLIBinaryOptions {
  readonly version: string;
  readonly failingCompletion?: string;
}

export function buildStubCLIBinary(options: StubCLIBinaryOptions): string {
  const failing =
    options.failingCompletion === undefined
      ? []
      : [`[ "$1 $2" = ${formatShellWord(`completion ${options.failingCompletion}`)} ] && exit 1`];

  return [
    '#!/bin/sh',
    `[ "$1" = --version ] && echo ${formatShellWord(options.version)} && exit 0`,
    ...failing,
    'exit 0',
    '',
  ].join('\n');
}
