import { readFileSync } from 'node:fs';
import { release as readKernelRelease } from 'node:os';
import { requireImp } from './imp-cli';
import { runInContainer } from './instance';
import { parseWholeNumber } from './parse-whole-number';

// KSM merges a VM's private anonymous memory from Linux 6.10 on.
export function isKsmSupported(release: string): boolean {
  const match = /^(?<major>\d+)\.(?<minor>\d+)/v.exec(release);
  const major = Number(match?.groups?.['major'] ?? 0);
  const minor = Number(match?.groups?.['minor'] ?? 0);

  return major > 6 || (major === 6 && minor >= 10);
}

export function parseCpuMsFromStat(stat: string): number {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

  return (Number(fields[11]) + Number(fields[12])) * 10;
}

export function parsePssMib(rollup: string): number {
  const getKb = (field: string): number =>
    Number(new RegExp(`^${field}:\\s+(?<kb>\\d+) kB$`, 'mv').exec(rollup)?.groups?.['kb'] ?? 0);

  return Math.round((getKb('Pss_Anon') + getKb('Pss_Shmem')) / 1024);
}

interface Mapping {
  readonly backing: string;
  readonly mib: number;

  readonly mapping: string;
}

function listMappings(smaps: string): readonly Mapping[] {
  const mappings: Mapping[] = [];
  const current = { backing: '', perms: '', mib: 0 };

  for (const line of smaps.split('\n')) {
    const header =
      /^(?<start>[\da-f]+)-(?<end>[\da-f]+) (?<perms>\S+) \S+ \S+ \S+\s*(?<backing>.*)$/v.exec(
        line,
      );

    if (header?.groups !== undefined) {
      const bytes =
        Number.parseInt(header.groups['end'] ?? '0', 16) -
        Number.parseInt(header.groups['start'] ?? '0', 16);

      current.backing = header.groups['backing'] ?? '';
      current.perms = header.groups['perms'] ?? '';
      current.mib = bytes / 1024 ** 2;
    } else if (line.startsWith('VmFlags:') && current.mib >= 1 && current.perms !== '---p') {
      mappings.push({
        backing: current.backing,
        mib: current.mib,
        mapping: `${current.perms}${line.includes(' mg') ? ' mg' : ''}`,
      });
    }
  }

  return mappings;
}

export function parseGuestMappings(smaps: string, guestMib: number): readonly string[] {
  const mappings = listMappings(smaps);
  const mibByBacking = Map.groupBy(mappings, (entry) => entry.backing);

  // A kernel may split a restore's memory across mappings of one backing.
  return mappings
    .filter(
      (entry) =>
        (mibByBacking.get(entry.backing) ?? []).reduce((sum, other) => sum + other.mib, 0) >=
        guestMib,
    )
    .map((entry) => entry.mapping);
}

function readHostFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export function checkHostRunsKsm(): boolean {
  return readHostFile('/sys/kernel/mm/ksm/run') === '1' && isKsmSupported(readKernelRelease());
}

export function readKsmdCpuMs(): number {
  const pid = parseWholeNumber(
    Bun.spawnSync(['pgrep', '-x', 'ksmd']).stdout.toString(),
    'ksmd pid',
  );

  return parseCpuMsFromStat(readHostFile(`/proc/${String(pid)}/stat`));
}

async function readContainerText(argv: readonly string[]): Promise<string> {
  const result = await runInContainer(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

async function readFirecrackerPid(name: string): Promise<string> {
  const imp = await requireImp(name);

  return readContainerText(['cat', `/var/lib/imp/imps/${imp.id}/run/pid`]);
}

export async function readVmPssMib(name: string): Promise<number> {
  const pid = await readFirecrackerPid(name);
  const rollup = await readContainerText(['cat', `/proc/${pid}/smaps_rollup`]);

  return parsePssMib(rollup);
}

export async function readMergingPages(name: string): Promise<number> {
  const pid = await readFirecrackerPid(name);
  const text = await readContainerText(['cat', `/proc/${pid}/ksm_merging_pages`]);

  return Number(text);
}

export async function readGuestMappings(name: string): Promise<readonly string[]> {
  const pid = await readFirecrackerPid(name);
  const smaps = await readContainerText(['cat', `/proc/${pid}/smaps`]);

  const guest = parseGuestMappings(smaps, 256);

  if (guest.length === 0) {
    throw new Error(`${name}: no guest memory mapping in pid ${pid}'s smaps`);
  }

  return guest;
}
