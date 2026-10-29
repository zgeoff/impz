import { existsSync, readFileSync } from 'node:fs';
import { requireImp } from './imp-cli';
import { runInContainer } from './instance';

const POOL_PAGES = '/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages';

// The suite needs a pool the host reserved and the device a jailed Firecracker
// opens; CI reserves the pool on one runner only.
export function checkHostHasHugePagePool(): boolean {
  try {
    return Number(readFileSync(POOL_PAGES, 'utf8').trim()) > 0 && existsSync('/dev/userfaultfd');
  } catch {
    return false;
  }
}

export function buildHugePageSettings(hasPool: boolean): Readonly<Record<string, string>> | null {
  return hasPool ? { IMP_HUGE_PAGES: '2M' } : null;
}

export function parseHugetlbMib(status: string): number {
  const kb = /^HugetlbPages:\s+(?<kb>\d+) kB$/mv.exec(status)?.groups?.['kb'];

  return Math.round(Number(kb ?? 0) / 1024);
}

async function readContainerText(argv: readonly string[]): Promise<string> {
  const result = await runInContainer(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

export async function readVmHugetlbMib(name: string): Promise<number> {
  const imp = await requireImp(name);
  const pid = await readContainerText(['cat', `/var/lib/imp/imps/${imp.id}/run/pid`]);
  const status = await readContainerText(['cat', `/proc/${pid}/status`]);

  return parseHugetlbMib(status);
}

// the page handler of an imp that restored or woke through one, or null
export async function readHandlerPid(name: string): Promise<string | null> {
  const imp = await requireImp(name);

  const found = await runInContainer([
    'sh',
    '-c',
    `p=$(cat /var/lib/imp/imps/${imp.id}/run/uffd.pid 2>/dev/null) && kill -0 "$p" && echo "$p"`,
  ]);

  return found.exitCode === 0 ? found.stdout.trim() : null;
}
