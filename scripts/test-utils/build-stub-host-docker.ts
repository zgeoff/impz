interface StubHostDocker {
  readonly image: string;
  readonly runningLabel: string;
  readonly pulledLabel: string;
  readonly pulledUnit: string;
  readonly pulledIsRunning?: boolean;
  readonly awakeImps?: readonly string[];
  readonly sleeplessImp?: string;
  readonly impInfo?: string | null;
  readonly runningCLI?: 'imp' | 'impz';
  readonly unreadableFile?: string;

  // Left unset, `docker compose config --environment` fails as it does in a Compose older than
  // 2.24.
  readonly composeConfig?: string;
  readonly composeConfigError?: string;
}

export function buildStubHostDocker(stub: StubHostDocker): string {
  const composeConfig =
    stub.composeConfig === undefined
      ? `printf '%s' ${buildShellWord(stub.composeConfigError ?? '')}; printf '%s' ${buildShellWord(stub.composeConfigError ?? '')} >&2; exit 1`
      : `printf '%s' ${buildShellWord(stub.composeConfig)}`;

  const imps = JSON.stringify((stub.awakeImps ?? []).map((name) => ({ name, state: 'running' })));

  const impInfo =
    stub.impInfo === null ? 'exit 1' : `printf '%s\\n' ${buildShellWord(stub.impInfo ?? '{}')}`;

  const cli = stub.runningCLI ?? 'impz';
  const version = cli === 'impz' ? 'echo 0.0.0' : 'exit 126';

  return `case "$*" in
  "inspect -f {{.Image}} imp-host") echo sha256:old ;;
  "inspect imp-host" | "pull -q "${buildShellWord(stub.image)}) ;;
  "image inspect -f {{.Id}} "${buildShellWord(stub.image)}) echo sha256:${stub.pulledIsRunning === true ? 'old' : 'new'} ;;
  "image inspect -f "*" sha256:old") echo ${buildShellWord(stub.runningLabel)} ;;
  "image inspect -f "*) echo ${buildShellWord(stub.pulledLabel)} ;;
  "run --rm "${buildShellWord(stub.image)}" cat "*${buildShellWord(stub.unreadableFile ?? 'none')}) exit 1 ;;
  "run --rm "${buildShellWord(stub.image)}" cat "*.service) printf '%s' ${buildShellWord(stub.pulledUnit)} ;;
  "run --rm "${buildShellWord(stub.image)}" cat "*.json) echo '{}' ;;
  "exec imp-host impz --version") ${version} ;;
  "exec imp-host ${cli} ls --json") echo ${buildShellWord(imps)} ;;
  "exec imp-host ${cli} sleep "${buildShellWord(stub.sleeplessImp ?? '')}) exit 1 ;;
  "exec imp-host ${cli} sleep "*) ;;
  "exec imp-host ${cli} info --json") ${impInfo} ;;
  "compose -f "*" config --environment")
    echo "compose config, IMP_HOST_IMAGE \${IMP_HOST_IMAGE-unset}, IMP_DOCKER_GID \${IMP_DOCKER_GID-unset}" >>"$STUB_CALLS"
    ${composeConfig} ;;
  "exec imp-host ${cli} ls" | "compose "*) ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac`;
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
