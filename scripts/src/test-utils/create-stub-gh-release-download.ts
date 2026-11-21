import { createStubBin } from '@impz/shared/test-utils/create-stub-bin';
import type { StubBin } from '@impz/shared/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';

export interface StubGhReleaseDownloadOptions {
  // the file whose bytes gh writes to its --output path, whatever the release and asset
  readonly source: string;

  // a nonzero code models a download that fails after writing what it had
  readonly exitCode?: number;
}

export function createStubGhReleaseDownload(
  directory: string,
  options: Readonly<StubGhReleaseDownloadOptions>,
): StubBin {
  return createStubBin(
    directory,
    'gh',
    `[ "$1 $2" = "release download" ] || exit 2
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift ;;
  esac
  shift
done
[ -n "$output" ] || exit 2
command -p cp ${formatShellWord(options.source)} "$output"
exit ${options.exitCode ?? 0}`,
  );
}
