import { createStubBin } from '@impz/shared/test-utils/create-stub-bin';
import type { StubBin } from '@impz/shared/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';

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
