import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubDevImage {
  readonly tag: string;
  readonly id: string;
  readonly labels: { readonly worktree: string; readonly machine: string } | null;
  readonly container?: string;
  readonly isStuck?: boolean;
}

export function buildStubDevDocker(images: readonly StubDevImage[]): string {
  const listed = images.map((image) => formatShellWord(`${image.tag} ${image.id}`)).join(' ');

  const inspects = images
    .filter((image) => image.labels !== null)
    .map(
      (image) =>
        `  "image inspect -f "*" "${formatShellWord(image.id)}) printf '%s\\t%s\\n' ${formatShellWord(image.labels?.worktree ?? '')} ${formatShellWord(image.labels?.machine ?? '')} ;;`,
    );

  const containers = images
    .filter((image) => image.container !== undefined)
    .map(
      (image) =>
        `  "ps -aq --filter ancestor="${formatShellWord(image.id)}) echo ${formatShellWord(image.container ?? '')} ;;`,
    );

  const stuck = images
    .filter((image) => image.isStuck === true)
    .map((image) => `  "image rm "${formatShellWord(image.tag)}) exit 1 ;;`);

  return [
    'case "$*" in',
    `  "image ls --filter label=imp.worktree --format "*) ${images.length === 0 ? ':' : `printf '%s\\n' ${listed}`} ;;`,
    ...inspects,
    '  "image inspect -f "*) exit 1 ;;',
    ...containers,
    '  "ps -aq --filter ancestor="*) ;;',
    ...stuck,
    '  "image rm "* | "image prune "*) ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n');
}
