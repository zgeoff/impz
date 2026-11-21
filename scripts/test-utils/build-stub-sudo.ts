import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';

interface StubSudoOptions {
  // commands that sudo hands on to the stand-in of that name, and answers with its exit code
  readonly runs?: readonly string[];

  // paths that `sudo tee` refuses, with the error tee prints
  readonly refusedTees?: readonly string[];
}

// The script of a sudo stand-in. Create it with recordStdin, so a `sudo tee` call keeps what it
// was given. It runs on bash builtins alone, because a test's PATH may hold only the stubs' folder.
export function buildStubSudo(options: Readonly<StubSudoOptions> = {}): string {
  const refusals = (options.refusedTees ?? []).map(
    (path) =>
      `[ "$1" = tee ] && [ "$2" = ${formatShellWord(path)} ] && { printf 'tee: %s: Invalid argument\\n' "$2" >&2; exit 1; }`,
  );

  const handOffs = (options.runs ?? []).map(
    (command) => `[ "$1" = ${formatShellWord(command)} ] && exec "$@"`,
  );

  return ['#!/bin/bash', ...refusals, ...handOffs, 'exit 0'].join('\n');
}
