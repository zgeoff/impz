import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';

// After each call, it calls the `unit` stand-in at unitStubPath with the unit's ExecStart line as it
// is then, or none, so the call is listed among the kit's. With envFile, a start or restart runs
// the unit's ExecStart as systemd would, with the unit's Environment= lines and then envFile's.
export function buildStubUnitSystemctl(
  unitPath: string,
  unitStubPath: string,
  envFile?: string,
): string {
  const unit = formatShellWord(unitPath);
  const log = `${formatShellWord(unitStubPath)} "$(grep -m 1 '^ExecStart=' ${unit} 2>/dev/null || echo none)"`;

  if (envFile === undefined) {
    return `#!/bin/bash\n${log}`;
  }

  return `#!/bin/bash
${log}
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
