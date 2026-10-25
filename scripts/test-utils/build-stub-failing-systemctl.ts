import { formatShellWord } from '@impz/test-utils/format-shell-word';

// The message is the one systemd prints when a unit's start job fails.
export function buildStubFailingSystemctl(verb: string): string {
  return `if [ "$1" = ${formatShellWord(verb)} ]; then
  unit=
  for arg in "\${@:2}"; do
    [[ $arg == -* ]] || unit=$arg
  done
  echo "Job for $unit.service failed because the control process exited with error code." >&2
  exit 1
fi`;
}
