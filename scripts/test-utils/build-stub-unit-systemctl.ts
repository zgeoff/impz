import { formatShellWord } from '@impz/test-utils/format-shell-word';

// With envFile, a start or restart runs the unit's ExecStart as systemd would, with the unit's
// Environment= lines and then envFile's, so a test reads the container's argv from the calls.
export function buildStubUnitSystemctl(unitPath: string, envFile?: string): string {
  const unit = formatShellWord(unitPath);
  const log = `printf '  unit: %s\\n' "$(grep -m 1 '^ExecStart=' ${unit} 2>/dev/null || echo none)" >>"$STUB_CALLS"`;

  if (envFile === undefined) {
    return log;
  }

  return `${log}
case "$1" in
  start | restart)
    while IFS= read -r line; do
      [[ $line =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "$line"
    done < <(sed -n 's/^Environment=//p' ${unit}; cat ${formatShellWord(envFile)} 2>/dev/null)
    command=$(awk '/^ExecStart=/ { on = 1 } on { line = $0; sub(/\\\\$/, "", line); printf "%s ", line; if ($0 !~ /\\\\$/) exit }' ${unit})
    command=\${command#ExecStart=/usr/bin/}
    eval "$command" >/dev/null 2>&1 || true
    ;;
esac`;
}
