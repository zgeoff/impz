import { createStubBin } from '@impz/test-utils/create-stub-bin';
import type { StubBin } from '@impz/test-utils/create-stub-bin';

// The stub runs on bash builtins alone, because a test's PATH may hold only the stubs' folder.
const RECORD_TEE_INPUT = String.raw`[ "$1" = tee ] && while IFS= read -r line; do printf '%s\n' "< $line" >>"$STUB_CALLS"; done`;

export function createStubSudo(directory: string, script = 'exit 0'): StubBin {
  return createStubBin(directory, 'sudo', `${RECORD_TEE_INPUT}\n${script}`);
}
