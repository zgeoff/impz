import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface StubCurlOptions {
  // the file whose bytes curl writes to its -o path, whatever the URL
  readonly source: string;

  // a nonzero code models a download that fails after writing what it had
  readonly exitCode?: number;
}

export function createStubCurl(directory: string, options: Readonly<StubCurlOptions>): StubBin {
  return createStubBin(
    directory,
    'curl',
    `output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift ;;
  esac
  shift
done
[ -n "$output" ] || exit 2
command -p cp ${formatShellWord(options.source)} "$output"
exit ${options.exitCode ?? 0}`,
  );
}
