import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const KSM_DIR = '/sys/kernel/mm/ksm';
const PAGE_BYTES = 4096;
const MIB = 1024 ** 2;

// Firecracker's own private mappings stay below this; the guest's memory
// from one backing adds up to more
const GUEST_MAPPING_MIN_BYTES = 64 * MIB;

// 6.7 keeps the merge flag across exec (3c6f33b7273a); 6.10 also has ksmd
// scan the exec'd process (3a9e567ca45f)
const MIN_KERNEL = { major: 6, minor: 10 } as const;

export interface KsmHostStats {
  readonly running: boolean;
  readonly sharedMib: number;

  // the kernel's general_profit goes negative while little is merged
  readonly profitMib: number;
  readonly zeroMib: number;
}

/* @internal */
export function checkKsmKernel(release: string): string | null {
  const match = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(release);
  const major = Number(match?.groups?.['major'] ?? Number.NaN);
  const minor = Number(match?.groups?.['minor'] ?? Number.NaN);

  const isNewEnough =
    major > MIN_KERNEL.major || (major === MIN_KERNEL.major && minor >= MIN_KERNEL.minor);

  if (isNewEnough) {
    return null;
  }

  return `IMP_KSM needs Linux ${String(MIN_KERNEL.major)}.${String(MIN_KERNEL.minor)} or later, which keeps the merge flag across exec and scans the exec'd process; this host runs ${release}`;
}

export function checkKsmHost(release: string, stats: KsmHostStats | null): string | null {
  const kernel = checkKsmKernel(release);

  if (kernel !== null) {
    return kernel;
  }

  return stats === null ? `IMP_KSM needs a kernel built with CONFIG_KSM (no ${KSM_DIR})` : null;
}

export function readKsmHostStats(directory = KSM_DIR): KsmHostStats | null {
  try {
    const readCount = (name: string): number => {
      try {
        return Number(readFileSync(`${directory}/${name}`, 'utf8').trim());
      } catch {
        return 0;
      }
    };

    const run = readFileSync(`${directory}/run`, 'utf8').trim();

    return {
      running: run === '1',
      sharedMib: Math.round((readCount('pages_sharing') * PAGE_BYTES) / MIB),
      profitMib: Math.round(readCount('general_profit') / MIB),
      zeroMib: Math.round((readCount('ksm_zero_pages') * PAGE_BYTES) / MIB),
    };
  } catch {
    return null;
  }
}

/* @internal */
export function checkMergeableMappings(smaps: string): boolean | null {
  const mappings: { backing: string; bytes: number; mergeable: boolean }[] = [];
  let current: (typeof mappings)[number] | null = null;

  for (const line of smaps.split('\n')) {
    const header =
      /^(?<start>[\da-f]+)-(?<end>[\da-f]+) (?<perms>\S+) \S+ \S+ \S+\s*(?<backing>.*)$/u.exec(
        line,
      );

    if (header?.groups !== undefined) {
      const bytes =
        Number.parseInt(header.groups['end'] ?? '0', 16) -
        Number.parseInt(header.groups['start'] ?? '0', 16);

      // Firecracker maps guest memory private and writable, as rw-p
      current =
        header.groups['perms'] === 'rw-p'
          ? { backing: header.groups['backing'] ?? '', bytes, mergeable: false }
          : null;

      if (current !== null) {
        mappings.push(current);
      }
    } else if (line.startsWith('VmFlags:') && current !== null) {
      // `mg` in VmFlags is the kernel's VM_MERGEABLE
      current.mergeable = line.split(/\s+/u).includes('mg');
    }
  }

  // A restore's guest memory, mapped from its template's mem file, can span several mappings.
  const bytesByBacking = new Map<string, number>();

  for (const mapping of mappings) {
    bytesByBacking.set(mapping.backing, (bytesByBacking.get(mapping.backing) ?? 0) + mapping.bytes);
  }

  const guest = mappings.filter(
    (mapping) => (bytesByBacking.get(mapping.backing) ?? 0) >= GUEST_MAPPING_MIN_BYTES,
  );

  if (guest.length === 0) {
    return null;
  }

  return guest.every((mapping) => mapping.mergeable);
}

/* @internal */
export function parseKsmStat(text: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();

  for (const line of text.split('\n')) {
    // from Linux 6.12, ksm_stat writes its flags as `name: value` and its counts as `name value`
    const match = /^(?<name>\w+):?\s+(?<value>\S+)$/u.exec(line.trim());

    if (match?.groups !== undefined) {
      fields.set(match.groups['name'] ?? '', match.groups['value'] ?? '');
    }
  }

  return fields;
}

async function readKsmStat(
  pid: number,
  procRoot: string,
): Promise<ReadonlyMap<string, string> | null> {
  try {
    const text = await readFile(`${procRoot}/${String(pid)}/ksm_stat`, 'utf8');

    return parseKsmStat(text);
  } catch {
    return null;
  }
}

export async function checkGuestMemoryMergeable(
  pid: number,
  procRoot = '/proc',
): Promise<boolean | null> {
  const stat = await readKsmStat(pid, procRoot);

  const mergeAny = stat?.get('ksm_merge_any');

  if (mergeAny !== undefined) {
    return mergeAny === 'yes';
  }

  // ksm_stat has ksm_merge_any from Linux 6.12; an older kernel shows the merge flag only in smaps
  try {
    const smaps = await readFile(`${procRoot}/${String(pid)}/smaps`, 'utf8');

    return checkMergeableMappings(smaps);
  } catch {
    return null;
  }
}

export async function readKsmProfitMib(pid: number, procRoot = '/proc'): Promise<number | null> {
  const stat = await readKsmStat(pid, procRoot);

  const profit = stat?.get('ksm_process_profit');

  return profit === undefined ? null : Number(profit) / MIB;
}
