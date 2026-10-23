import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export function createStubCat(directory: string, files: Readonly<Record<string, string>>): StubBin {
  const answers = Object.entries(files)
    .map(([path, line]) => `  ${formatShellWord(path)}) printf '%s\\n' ${formatShellWord(line)} ;;`)
    .join('\n');

  return createStubBin(
    directory,
    'cat',
    `if [ "$#" -eq 1 ]; then
  case "$1" in
${answers}
    *) command -p cat "$@" ;;
  esac
else
  command -p cat "$@"
fi`,
  );
}
