import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

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
