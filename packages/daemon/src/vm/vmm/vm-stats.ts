import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readStatFields } from '../../platform/process/proc';
import { probeProcessAlive } from './firecracker-process';

const KIB_PER_MIB = 1024;

/* @internal */
export function parseProcFields(text: string): ReadonlyMap<string, number> {
  const fields = new Map<string, number>();

  for (const line of text.split('\n')) {
    const match = /^(?<name>\w+):\s+(?<kb>\d+) kB$/u.exec(line);

    if (match?.groups !== undefined) {
      fields.set(match.groups['name'] ?? '', Number(match.groups['kb']));
    }
  }

  return fields;
}

export function readOwnedRamMib(pid: number, apiSocket: string, procRoot = '/proc'): number | null {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  return fields === null ? null : countOwnedMib(fields);
}

// A VM's RAM with the pool pages it holds, both from one read, so a fault between two reads never
// shows as RAM outside the pool.
export interface VmRam {
  readonly ramMib: number;
  readonly hugetlbMib: number;
}

// The kernel walks every page the VM maps to answer smaps_rollup, tens of ms
// for a guest of some GiB, so this read stays off the event loop.
export async function readOwnedRamAsync(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): Promise<VmRam | null> {
  if (!probeProcessAlive(pid, apiSocket, procRoot)) {
    return null;
  }

  try {
    const [rollup, status] = await Promise.all([
      readFile(`${procRoot}/${String(pid)}/smaps_rollup`, 'utf8'),
      readFile(`${procRoot}/${String(pid)}/status`, 'utf8'),
    ]);

    const fields = addHugetlbPages(parseProcFields(rollup), status);

    return {
      ramMib: countOwnedMib(fields),
      hugetlbMib: Math.round((fields.get('HugetlbPages') ?? 0) / KIB_PER_MIB),
    };
  } catch {
    return null;
  }
}

// The kernel keeps these counters per process, so this read walks no pages. A page's Rss is never
// less than its Pss, so the sum bounds what smaps_rollup's anonymous and shmem Pss count.
export async function readResidentRamAsync(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): Promise<VmRam | null> {
  if (!probeProcessAlive(pid, apiSocket, procRoot)) {
    return null;
  }

  try {
    const text = await readFile(`${procRoot}/${String(pid)}/status`, 'utf8');

    const fields = parseProcFields(text);
    const hugetlbKb = fields.get('HugetlbPages') ?? 0;

    return {
      ramMib: Math.round(
        ((fields.get('RssAnon') ?? 0) + (fields.get('RssShmem') ?? 0) + hugetlbKb) / KIB_PER_MIB,
      ),
      hugetlbMib: Math.round(hugetlbKb / KIB_PER_MIB),
    };
  } catch {
    return null;
  }
}

export async function readHugetlbMibAsync(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): Promise<number | null> {
  if (!probeProcessAlive(pid, apiSocket, procRoot)) {
    return null;
  }

  try {
    const text = await readFile(`${procRoot}/${String(pid)}/status`, 'utf8');

    return Math.round((parseProcFields(text).get('HugetlbPages') ?? 0) / KIB_PER_MIB);
  } catch {
    return null;
  }
}

function countOwnedMib(fields: ReadonlyMap<string, number>): number {
  return Math.round(
    ((fields.get('Pss_Anon') ?? 0) +
      (fields.get('Pss_Shmem') ?? 0) +
      (fields.get('HugetlbPages') ?? 0)) /
      KIB_PER_MIB,
  );
}

// Rss and Pss leave out the hugetlb pages that back a guest on 2 MiB pages,
// which the kernel counts apart in the process's status.
function addHugetlbPages(
  rollup: ReadonlyMap<string, number>,
  status: string,
): ReadonlyMap<string, number> {
  const hugetlbKb = parseProcFields(status).get('HugetlbPages') ?? 0;

  return new Map([...rollup, ['HugetlbPages', hugetlbKb]]);
}

export function readUnsharedRamMib(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): number | null {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  return fields === null ? null : countUnsharedMib(fields);
}

/* @internal */
export function countUnsharedMib(fields: ReadonlyMap<string, number>): number {
  // KSM splits a merged page's Pss across the VMs that map it, and a write unmerges the page, so a
  // wake reserve counts every page in full.
  return Math.round(
    ((fields.get('Anonymous') ?? 0) +
      (fields.get('Pss_Shmem') ?? 0) +
      (fields.get('HugetlbPages') ?? 0)) /
      KIB_PER_MIB,
  );
}

export function readRssMib(pid: number, apiSocket: string, procRoot = '/proc'): number | null {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  return fields === null ? null : Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB);
}

export function readVmMemory(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): { readonly ramMib: number | null; readonly rssMib: number | null } {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  if (fields === null) {
    return { ramMib: null, rssMib: null };
  }

  return {
    ramMib: countOwnedMib(fields),
    rssMib: Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB),
  };
}

function readVmSmaps(
  pid: number,
  apiSocket: string,
  procRoot: string,
): ReadonlyMap<string, number> | null {
  if (!probeProcessAlive(pid, apiSocket, procRoot)) {
    return null;
  }

  try {
    const rollup = readFileSync(`${procRoot}/${String(pid)}/smaps_rollup`, 'utf8');
    const status = readFileSync(`${procRoot}/${String(pid)}/status`, 'utf8');

    return addHugetlbPages(parseProcFields(rollup), status);
  } catch {
    return null;
  }
}

export function readCpuTicks(pid: number, procRoot = '/proc'): number | null {
  // the fields after the parenthesised command name, from /proc stat's field 3
  const fields = readStatFields(pid, procRoot);

  // the kernel counts utime and stime in USER_HZ ticks, 100 a second on Linux
  return fields === null ? null : Number(fields[11]) + Number(fields[12]);
}

export function readThreadIds(pid: number, procRoot = '/proc'): number[] | null {
  try {
    return readdirSync(`${procRoot}/${String(pid)}/task`)
      .filter((name) => /^\d+$/v.test(name))
      .map(Number);
  } catch {
    return null;
  }
}
