import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';
import { createStubBin } from '@zgeoff/testing/bin';
import type { StubBin } from '@zgeoff/testing/bin';

export function createStubMountpoint(
  directory: string,
  unmounted: readonly [string, ...string[]],
): StubBin {
  return createStubBin(directory, 'mountpoint', {
    script: `#!/bin/bash\ncase "$2" in
  ${unmounted.map((path) => formatShellWord(path)).join(' | ')}) exit 1 ;;
esac`,
  });
}
