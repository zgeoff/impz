import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubHostPodman {
  readonly image: string;
  readonly pulledLabel: string;
  readonly pulledUnit: string;
  readonly pulledIsRunning?: boolean;

  // Left unset, Podman runs imp-host; false leaves it to Docker, or to nothing.
  readonly runsHost?: boolean;
  readonly awakeImps?: readonly string[];
  readonly sleeplessImp?: string;
  readonly impInfo?: string | null;
  readonly runningCLI?: 'imp' | 'impz';
  readonly unreadableFile?: string;

  // The inspect that fails, as one does when its container or image is gone: imp-host's image id,
  // or the pulled image's own id.
  readonly failedInspect?: 'host' | 'pulled';
}

export function buildStubHostPodman(stub: StubHostPodman): string {
  const imps = JSON.stringify((stub.awakeImps ?? []).map((name) => ({ name, state: 'running' })));

  const impInfo =
    stub.impInfo === null ? 'exit 1' : `printf '%s\\n' ${formatShellWord(stub.impInfo ?? '{}')}`;

  const cli = stub.runningCLI ?? 'impz';
  const version = cli === 'impz' ? 'echo 0.0.0' : 'exit 126';
  const runsHost = stub.runsHost === false ? 'exit 1' : '';
  const noSuchObject = 'echo "Error: no such object" >&2; exit 125';
  const hostImage = stub.failedInspect === 'host' ? noSuchObject : 'echo old';

  const pulledImage =
    stub.failedInspect === 'pulled'
      ? noSuchObject
      : `echo ${stub.pulledIsRunning === true ? 'old' : 'new'}`;

  // Podman prints an image id without the sha256: that Docker puts before it.
  return `case "$*" in
  "container exists imp-host") ${runsHost} ;;
  "inspect -f {{.Image}} imp-host") ${hostImage} ;;
  "pull -q "${formatShellWord(stub.image)}) ;;
  "image inspect -f {{.Id}} "${formatShellWord(stub.image)}) ${pulledImage} ;;
  "image inspect -f "*" "${formatShellWord(stub.image)}) echo ${formatShellWord(stub.pulledLabel)} ;;
  "run --rm "${formatShellWord(stub.image)}" cat "*${formatShellWord(stub.unreadableFile ?? 'none')}) exit 1 ;;
  "run --rm "${formatShellWord(stub.image)}" cat "*.service) printf '%s' ${formatShellWord(stub.pulledUnit)} ;;
  "run --rm "${formatShellWord(stub.image)}" cat "*.json) echo '{}' ;;
  "exec imp-host impz --version") ${version} ;;
  "exec imp-host ${cli} ls --json") echo ${formatShellWord(imps)} ;;
  "exec imp-host ${cli} sleep "${formatShellWord(stub.sleeplessImp ?? '')}) exit 1 ;;
  "exec imp-host ${cli} sleep "*) ;;
  "exec imp-host ${cli} info --json") ${impInfo} ;;
  "exec imp-host ${cli} ls") ;;
  *) echo "unexpected: podman $*" >&2; exit 1 ;;
esac`;
}
