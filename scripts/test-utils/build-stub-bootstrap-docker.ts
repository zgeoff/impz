import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubBootstrapDocker {
  readonly serverVersion?: string;
  readonly hostNetwork?: string;
  readonly networkContainers?: readonly string[];
  readonly images?: readonly string[];
  readonly seccompImages?: readonly string[];
  readonly impInfo?: string;
  readonly published?: string;
  readonly dataMount?: string;
  readonly ipv6Route?: string;
  readonly logs?: string;
  readonly runningCLI?: 'imp' | 'impz';
}

const SECCOMP_IN_IMAGE = '/usr/local/share/imp/deploy/imp-host.seccomp.json';

export function buildStubBootstrapDocker(stub: StubBootstrapDocker): string {
  const version =
    stub.serverVersion === undefined
      ? 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1'
      : `echo ${formatShellWord(stub.serverVersion)}`;

  const noNetwork = 'echo "Error response from daemon: network imp-host not found" >&2; exit 1';
  const containers = (stub.networkContainers ?? []).map((name) => `${name} `).join('');
  const images = (stub.images ?? []).map((image) => formatShellWord(image));
  const seccompImages = (stub.seccompImages ?? []).map((image) => formatShellWord(image));
  const cli = stub.runningCLI ?? 'impz';
  const cliVersion = cli === 'impz' ? 'echo 0.0.0' : 'exit 126';

  return `case "$*" in
  "version -f {{.Server.Version}}") ${version} ;;
  "network inspect -f {{range .Containers}}{{.Name}} {{end}} imp-host") ${stub.hostNetwork === undefined ? noNetwork : `echo ${formatShellWord(containers)}`} ;;
  "network inspect -f "*" imp-host" | "network inspect imp-host") ${stub.hostNetwork === undefined ? noNetwork : `echo ${formatShellWord(stub.hostNetwork)}`} ;;
${images.map((image) => `  "image inspect "${image}) ;;`).join('\n')}
  "image inspect "*) echo "Error response from daemon: No such image: \${*: -1}" >&2; exit 1 ;;
  "load -q -i "*) ;;
${seccompImages.map((image) => `  "run --rm "${image}" cat ${SECCOMP_IN_IMAGE}") echo '{}' ;;`).join('\n')}
  "run --rm "*" cat ${SECCOMP_IN_IMAGE}") echo "cat: ${SECCOMP_IN_IMAGE}: No such file or directory" >&2; exit 1 ;;
  "exec imp-host impz --version") ${cliVersion} ;;
  "exec imp-host ${cli} info" | "exec imp-host ${cli} info --json") ${buildPrint(stub.impInfo)} ;;
  "port imp-host") ${buildPrint(stub.published)} ;;
  "exec imp-host findmnt -n -r -o SOURCE,FSTYPE --mountpoint /var/lib/imp") ${buildPrint(stub.dataMount)} ;;
  "exec imp-host ip -6 route show default") ${buildPrint(stub.ipv6Route)} ;;
  "logs imp-host") ${buildPrint(stub.logs)} ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac`;
}

function buildPrint(value: string | undefined): string {
  return value === undefined ? ':' : `printf '%s\\n' ${formatShellWord(value)}`;
}
