import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubPushDockerOptions {
  // what `docker buildx imagetools inspect` prints, a digest or anything the registry gives
  readonly inspected: string;
  readonly isPushRefused?: boolean;
}

export function buildStubPushDocker(options: StubPushDockerOptions): string {
  const push = options.isPushRefused === true ? 'exit 1' : 'exit 0';

  return `case "$1 $2 $3" in
  "push "*) ${push} ;;
  "buildx imagetools inspect") printf '%s\\n' ${formatShellWord(options.inspected)}; exit 0 ;;
esac
exit 0`;
}
