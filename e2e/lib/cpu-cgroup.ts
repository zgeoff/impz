import { requireImp, runShellInImp } from './imp-cli';
import { runInContainer } from './instance';

export interface CpuStat {
  readonly usageUsec: number;
  readonly throttledUsec: number;
}

export function parseCpuStat(text: string): CpuStat {
  const getField = (field: string): number => {
    const value = new RegExp(`^${field} (?<value>\\d+)$`, 'mv').exec(text)?.groups?.['value'];

    if (value === undefined) {
      throw new TypeError(`no ${field} in cpu.stat: ${JSON.stringify(text)}`);
    }

    return Number(value);
  };

  return { usageUsec: getField('usage_usec'), throttledUsec: getField('throttled_usec') };
}

export async function readImpCgroupDir(name: string): Promise<string> {
  const row = await requireImp(name);

  return `/sys/fs/cgroup/imps/${row.id}`;
}

export async function readContainerFile(path: string): Promise<string> {
  const result = await runInContainer(['cat', path]);

  if (result.exitCode !== 0) {
    throw new Error(`cat ${path} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

export interface BusyLoop {
  // An upper bound: a loaded host may give the VM less CPU, never more.
  readonly share: number;
  readonly throttledUsec: number;
}

export async function runBusyLoop(name: string, seconds: number): Promise<BusyLoop> {
  const directory = await readImpCgroupDir(name);
  const before = await readContainerFile(`${directory}/cpu.stat`);

  const started = performance.now();

  await runShellInImp(
    name,
    `end=$(($(date +%s) + ${String(seconds)})); while [ "$(date +%s)" -lt "$end" ]; do :; done`,
  );

  const wallUsec = (performance.now() - started) * 1000;

  const after = await readContainerFile(`${directory}/cpu.stat`);

  const statBefore = parseCpuStat(before);
  const statAfter = parseCpuStat(after);

  return {
    share: (statAfter.usageUsec - statBefore.usageUsec) / wallUsec,
    throttledUsec: statAfter.throttledUsec - statBefore.throttledUsec,
  };
}
