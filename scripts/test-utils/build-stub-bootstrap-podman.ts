import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubBootstrapPodman {
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

// Podman 4.9's answers: a missing network or image fails with exit 125, network exists fails
// with exit 1 and no output, and ps with a filter prints one name per line.
export function buildStubBootstrapPodman(stub: StubBootstrapPodman): string {
  const noNetwork =
    'echo "Error: network imp-host: unable to find network with name or ID imp-host: network not found" >&2; exit 125';

  const containers = (stub.networkContainers ?? []).join('\n');
  const images = (stub.images ?? []).map((image) => formatShellWord(image));
  const seccompImages = (stub.seccompImages ?? []).map((image) => formatShellWord(image));
  const cli = stub.runningCLI ?? 'impz';
  const cliVersion = cli === 'impz' ? 'echo 0.0.0' : 'exit 126';

  return `case "$*" in
  "network inspect -f "*" imp-host") ${stub.hostNetwork === undefined ? noNetwork : `echo ${formatShellWord(stub.hostNetwork)}`} ;;
  "network exists imp-host") ${stub.hostNetwork === undefined ? 'exit 1' : ':'} ;;
  "ps -a --filter network=imp-host --format {{.Names}}") ${stub.hostNetwork === undefined || containers === '' ? ':' : `printf '%s\\n' ${formatShellWord(containers)}`} ;;
${images.map((image) => `  "image inspect "${image}) ;;`).join('\n')}
  "image inspect "*) echo "Error: \${*: -1}: image not known" >&2; exit 125 ;;
  "load -q -i "*) ;;
${seccompImages.map((image) => `  "run --rm "${image}" cat ${SECCOMP_IN_IMAGE}") echo '{}' ;;`).join('\n')}
  "run --rm "*" cat ${SECCOMP_IN_IMAGE}") echo "cat: ${SECCOMP_IN_IMAGE}: No such file or directory" >&2; exit 1 ;;
  "exec imp-host impz --version") ${cliVersion} ;;
  "exec imp-host ${cli} info" | "exec imp-host ${cli} info --json") ${buildPrint(stub.impInfo)} ;;
  "port imp-host") ${buildPrint(stub.published)} ;;
  "exec imp-host findmnt -n -r -o SOURCE,FSTYPE --mountpoint /var/lib/imp") ${buildPrint(stub.dataMount)} ;;
  "exec imp-host ip -6 route show default") ${buildPrint(stub.ipv6Route)} ;;
  "logs imp-host") ${buildPrint(stub.logs)} ;;
  *)echo "unexpected: podman $*" >&2; exit 1 ;;
esac`;
}

function buildPrint(value: string | undefined): string {
  return value === undefined ? ':' : `printf '%s\\n' ${formatShellWord(value)}`;
}
