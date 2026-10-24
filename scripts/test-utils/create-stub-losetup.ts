import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface StubLosetupOptions {
  // what -f prints for the free device; with none, -f fails as on a kernel without one
  readonly free?: string;
  readonly attached?: string;

  // attaches that fail before one succeeds, as when another container takes the device first
  readonly busyAttaches?: number;
}

export function createStubLosetup(
  directory: string,
  options: Readonly<StubLosetupOptions> = {},
): StubBin {
  const attaches = formatShellWord(join(directory, 'losetup-attaches'));
  const onFree = options.free === undefined ? 'exit 1' : `echo ${formatShellWord(options.free)}`;

  const onAttached =
    options.attached === undefined ? ':' : `echo ${formatShellWord(options.attached)}`;

  return createStubBin(
    directory,
    'losetup',
    `case "$1" in
  -f) ${onFree} ;;
  -j) ${onAttached} ;;
  /dev/*)
    count=$(command -p cat ${attaches} 2>/dev/null || echo 0)
    echo $((count + 1)) >${attaches}
    [ "$count" -ge ${options.busyAttaches ?? 0} ] || exit 1
    ;;
esac`,
  );
}
