import { createStubBin } from '@impz/test-utils/create-stub-bin';
import type { StubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

export function createStubMountpoint(
  directory: string,
  unmounted: readonly [string, ...string[]],
): StubBin {
  return createStubBin(
    directory,
    'mountpoint',
    `case "$2" in
  ${unmounted.map((path) => formatShellWord(path)).join(' | ')}) exit 1 ;;
esac`,
  );
}
