interface StubDevHostDocker {
  readonly containers: Readonly<Record<string, boolean>>;
  readonly hasImage: boolean;
  readonly hasSocket: boolean;
  readonly logs?: Readonly<Record<string, string>>;

  // pgrep exits 1 when no process matches.
  readonly impdPids?: readonly number[];
  readonly impdExits?: boolean;
}

export function buildStubDevHostDocker(stub: StubDevHostDocker): string {
  const states = Object.entries(stub.containers).map(
    ([name, isRunning]) =>
      `  "inspect -f {{.State.Running}} "${buildShellWord(name)}) echo ${isRunning ? 'true' : 'false'} ;;`,
  );

  const logs = Object.entries(stub.logs ?? {}).map(
    ([name, log]) =>
      `  "logs --tail "*" "${buildShellWord(name)}) printf '%s' ${buildShellWord(log)} ;;`,
  );

  const pids = stub.impdPids ?? [];

  const pgrep =
    pids.length === 0
      ? '  "exec "*" pgrep -f "*) exit 1 ;;'
      : `  "exec "*" pgrep -f "*) printf '%s\\n' ${pids.join(' ')} ;;`;

  return [
    'case "$*" in',
    pgrep,
    '  "exec "*" kill -HUP "*) ;;',
    `  "exec "*" kill -0 "*) exit ${(stub.impdExits ?? true) ? 1 : 0} ;;`,
    '  "image inspect -f {{.Id}} "*) echo sha256:stub-host-image ;;',
    `  "image inspect "*) exit ${stub.hasImage ? 0 : 1} ;;`,
    ...states,
    '  "inspect -f {{.State.Running}} "*) echo "Error: No such object" >&2; exit 1 ;;',
    '  "run --rm "*)',
    '    for arg in "$@"; do',
    `      case $arg in *:/out) : >"$(printf '%s' "$arg" | sed 's|:/out$||')/imp-docker-proxy.new" ;; esac`,
    '    done',
    '    ;;',
    '  "run -d "*) echo c0ffee ;;',
    '  "rm -f "*) ;;',
    `  "exec "*" test -S /run/imp-docker/docker.sock") exit ${stub.hasSocket ? 0 : 1} ;;`,
    ...logs,
    '  "logs --tail "*) ;;',
    '  *) echo "stub docker: unexpected call: $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n');
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
