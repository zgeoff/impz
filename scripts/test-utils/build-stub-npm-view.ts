import { formatShellWord } from '@impz/test-utils/format-shell-word';

// `npm view <name>@<version> version` prints the version when the registry holds it, and fails with
// E404 when it does not.
export function buildStubNpmView(published: readonly string[]): string {
  const answers = published.map((spec) => {
    const version = spec.slice(spec.lastIndexOf('@') + 1);

    return `  ${formatShellWord(spec)}) echo ${formatShellWord(version)}; exit 0 ;;`;
  });

  return [
    '[ "$1 $3" = "view version" ] || exit 1',
    'case "$2" in',
    ...answers,
    'esac',
    'echo "npm error code E404" >&2',
    'exit 1',
  ].join('\n');
}
