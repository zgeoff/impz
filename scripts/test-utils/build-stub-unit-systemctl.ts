import { formatShellWord } from '@impz/test-utils/format-shell-word';

export function buildStubUnitSystemctl(unitPath: string): string {
  return `printf '  unit: %s\\n' "$(grep -m 1 '^ExecStart=' ${formatShellWord(unitPath)} 2>/dev/null || echo none)" >>"$STUB_CALLS"`;
}
