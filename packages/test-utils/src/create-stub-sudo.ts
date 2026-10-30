import { createStubBin } from '@impz/test-utils/create-stub-bin';
import type { StubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubSudoOptions {
  readonly script?: string;
  readonly runs?: readonly string[];
}

// The stub runs on bash builtins alone, because a test's PATH may hold only the stubs' folder.
const RECORD_TEE_INPUT = String.raw`[ "$1" = tee ] && while IFS= read -r line; do printf '%s\n' "< $line" >>"$STUB_CALLS"; done`;

export function createStubSudo(directory: string, options: StubSudoOptions = {}): StubBin {
  const handOffs = (options.runs ?? []).map(
    (command) => `[ "$1" = ${formatShellWord(command)} ] && exec "$@"`,
  );

  return createStubBin(
    directory,
    'sudo',
    [RECORD_TEE_INPUT, ...handOffs, options.script ?? 'exit 0'].join('\n'),
  );
}
