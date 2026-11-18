import { readFileSync, readdirSync } from 'node:fs';

export function readStatFields(pid: number, procRoot = '/proc'): string[] | null {
  try {
    const stat = readFileSync(`${procRoot}/${String(pid)}/stat`, 'utf8');

    // the command name in /proc/<pid>/stat may hold spaces and parentheses
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trimEnd()
      .split(' ');
  } catch {
    return null;
  }
}

export function listPids(procRoot = '/proc'): number[] {
  return readdirSync(procRoot)
    .filter((entry) => /^\d+$/v.test(entry))
    .map(Number);
}

export function stopPid(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {}
}
