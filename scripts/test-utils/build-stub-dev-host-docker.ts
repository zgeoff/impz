import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubDevHostDocker {
  readonly containers: Readonly<Record<string, boolean>>;
  readonly hasImage: boolean;
  readonly logs?: Readonly<Record<string, string>>;

  // pgrep exits 1 when no process matches.
  readonly impdPids?: readonly number[];
  readonly impdExits?: boolean;

  // A pgrep that cannot run at all, as docker exec reports a missing binary with exit 127.
  readonly impdLookupError?: { readonly exitCode: number; readonly stderr: string };
}

export function buildStubDevHostDocker(stub: StubDevHostDocker): string {
  const states = Object.entries(stub.containers).map(
    ([name, isRunning]) =>
      `  "inspect -f {{.State.Running}} "${formatShellWord(name)}) echo ${isRunning ? 'true' : 'false'} ;;`,
  );

  const logs = Object.entries(stub.logs ?? {}).map(
    ([name, log]) =>
      `  "logs --tail "*" "${formatShellWord(name)}) printf '%s' ${formatShellWord(log)} ;;`,
  );

  const pids = stub.impdPids ?? [];
  const lookupError = stub.impdLookupError;

  const pgrepMatch =
    pids.length === 0
      ? '  "exec "*" pgrep -f "*) exit 1 ;;'
      : `  "exec "*" pgrep -f "*) printf '%s\\n' ${pids.join(' ')} ;;`;

  const pgrep =
    lookupError === undefined
      ? pgrepMatch
      : `  "exec "*" pgrep -f "*) printf '%s' ${formatShellWord(lookupError.stderr)} >&2; exit ${String(lookupError.exitCode)} ;;`;

  return [
    'case "$*" in',
    pgrep,
    '  "exec "*" kill -HUP "*) ;;',
    `  "exec "*" kill -0 "*) exit ${(stub.impdExits ?? true) ? 1 : 0} ;;`,
    '  "image inspect -f {{.Id}} "*) echo sha256:stub-host-image ;;',
    `  "image inspect "*) exit ${stub.hasImage ? 0 : 1} ;;`,

    // podman's own spelling of the image check; every other call is the same in both CLIs.
    `  "image exists "*) exit ${stub.hasImage ? 0 : 1} ;;`,
    '  "build -q "*) echo sha256:stub-built-image ;;',
    ...states,
    '  "inspect -f {{.State.Running}} "*) echo "Error: No such object" >&2; exit 1 ;;',
    '  "run -d "*) echo c0ffee ;;',
    '  "stop -t "*) ;;',
    '  "rm -f "*) ;;',
    ...logs,
    '  "logs --tail "*) ;;',
    '  *) echo "stub $(basename "$0"): unexpected call: $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n');
}
