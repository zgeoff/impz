import { runShellInImp } from './imp-cli';
import { parseWholeNumber } from './parse-whole-number';

// Read from /proc, since ps lists every process in BusyBox but only the
// caller's session in procps.
export async function countGuestSleeps(name: string, secondsPattern: string): Promise<number> {
  const stdout = await runShellInImp(
    name,
    `for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done | grep -c '^sleep ${secondsPattern} ' || true`,
  );

  return parseWholeNumber(stdout, `${name}'s sleep count`);
}
