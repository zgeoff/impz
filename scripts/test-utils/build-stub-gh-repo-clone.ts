import { formatShellWord } from '@impz/test-utils/format-shell-word';

// `gh repo clone <repo> <dir>` clones the given remote into <dir>, or makes <dir> empty for no
// remote, and every other gh command passes. git and mkdir come from the test's PATH.
export function buildStubGhRepoClone(remote: string | null): string {
  const clone =
    remote === null ? 'mkdir -p "$4"' : `exec git clone -q ${formatShellWord(remote)} "$4"`;

  return `[ "$1 $2" = "repo clone" ] && ${clone}\nexit 0`;
}
