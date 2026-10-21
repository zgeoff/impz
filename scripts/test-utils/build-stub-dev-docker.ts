interface StubDevImage {
  readonly tag: string;
  readonly id: string;
  readonly labels: { readonly worktree: string; readonly machine: string } | null;
  readonly container?: string;
  readonly isStuck?: boolean;
}

export function buildStubDevDocker(images: readonly StubDevImage[]): string {
  const listed = images.map((image) => buildShellWord(`${image.tag} ${image.id}`)).join(' ');

  const inspects = images
    .filter((image) => image.labels !== null)
    .map(
      (image) =>
        `  "image inspect -f "*" "${buildShellWord(image.id)}) printf '%s\\t%s\\n' ${buildShellWord(image.labels?.worktree ?? '')} ${buildShellWord(image.labels?.machine ?? '')} ;;`,
    );

  const containers = images
    .filter((image) => image.container !== undefined)
    .map(
      (image) =>
        `  "ps -aq --filter ancestor="${buildShellWord(image.id)}) echo ${buildShellWord(image.container ?? '')} ;;`,
    );

  const stuck = images
    .filter((image) => image.isStuck === true)
    .map((image) => `  "image rm "${buildShellWord(image.tag)}) exit 1 ;;`);

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

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
