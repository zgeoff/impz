import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubHostDocker {
  readonly awakeImps?: readonly string[];
  readonly sleeplessImp?: string;
  readonly runningCLI?: 'imp' | 'impz';

  // The containers on Docker's imp-host network, as a host with IPv6 has it; left unset, Docker
  // has no such network.
  readonly hostNetwork?: readonly string[];

  // Docker refuses to remove that network, as it does while an endpoint still holds it.
  readonly networkInUse?: boolean;
}

export function buildStubHostDocker(stub: StubHostDocker): string {
  const imps = JSON.stringify((stub.awakeImps ?? []).map((name) => ({ name, state: 'running' })));
  const cli = stub.runningCLI ?? 'impz';
  const version = cli === 'impz' ? 'echo 0.0.0' : 'exit 126';

  const network =
    stub.hostNetwork === undefined
      ? { inspect: 'echo "Error: No such network: imp-host" >&2; exit 1', remove: 'exit 1' }
      : {
          inspect: `printf '%s ' ${stub.hostNetwork.map((name) => formatShellWord(name)).join(' ')}; echo`,
          remove:
            stub.networkInUse === true
              ? 'echo "Error response from daemon: error while removing network: network imp-host has active endpoints" >&2; exit 1'
              : 'echo imp-host',
        };

  return `case "$*" in
  "container inspect imp-host") ;;
  "inspect -f {{.Image}} imp-host") echo sha256:old ;;
  "exec imp-host impz --version") ${version} ;;
  "exec imp-host ${cli} ls --json") echo ${formatShellWord(imps)} ;;
  "exec imp-host ${cli} sleep "${formatShellWord(stub.sleeplessImp ?? '')}) exit 1 ;;
  "exec imp-host ${cli} sleep "*) ;;
  "rm -f imp-host") echo imp-host ;;
  "network inspect -f "*" imp-host") ${network.inspect} ;;
  "network rm imp-host") ${network.remove} ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac`;
}
