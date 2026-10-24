import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CpuSettings } from '../../platform/db/imps';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { readProcessCgroup } from './process-owner';

const PERIOD_US = 100_000;

// Room above the guest for Firecracker and the page cache of its disk and
// snapshot I/O, which the kernel reclaims at memory.max before an OOM kill.
const MEMORY_MIN_OVERHEAD_MIB = 256;
const MEMORY_OVERHEAD_DIVISOR = 8;
const BYTES_PER_MIB = 1024 * 1024;

// rmdir answers EBUSY until the kernel lets go of an exited process
const REMOVE_TRIES = 40;
const REMOVE_WAIT_MS = 50;

export interface ImpCgroup {
  readonly procsPath: string;

  // a throttled VMM thread stretches a snapshot's pause past what the guest
  // tolerates, so the limit lifts while a snapshot is made or loaded
  readonly liftLimit: () => void;
  readonly applyLimit: () => void;
}

export interface CpuStat {
  readonly usageUsec: number;
  readonly throttledUsec: number;
}

export interface CpuCgroups {
  readonly isEnforced: boolean;
  readonly isMemoryEnforced: boolean;
  readonly setup: (impId: string, cpu: CpuSettings, memoryMib: number) => ImpCgroup | null;
  readonly apply: (impId: string, cpu: CpuSettings) => void;
  readonly adopt: (impId: string, pid: number, cpu: CpuSettings, memoryMib: number) => void;
  readonly remove: (impId: string) => Promise<void>;
  readonly setGuestMib: (impId: string, guestMib: number) => void;
  readonly removeOrphans: (impIds: ReadonlySet<string>) => string[];
  readonly readCpuStat: (impId: string) => CpuStat | null;
  readonly readOomKills: (impId: string) => number | null;
  readonly probeOomKillSinceStart: (impId: string) => boolean;
  readonly kill: (impId: string) => void;
}

interface CpuCgroupOptions {
  readonly root: string;
  readonly procRoot?: string;
  readonly rmdir?: (path: string) => void;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

/* @internal */
export function formatCpuMax(limit: number | null): string {
  return limit === null
    ? `max ${String(PERIOD_US)}`
    : `${String(Math.round(limit * PERIOD_US))} ${String(PERIOD_US)}`;
}

/* @internal */
export function parseCpuStat(text: string): CpuStat | null {
  const fields = new Map(
    text
      .split('\n')
      .map((line) => line.split(' '))
      .map(([key, value]) => [key ?? '', Number(value)] as const),
  );

  const usageUsec = fields.get('usage_usec');

  if (usageUsec === undefined || Number.isNaN(usageUsec)) {
    return null;
  }

  return { usageUsec, throttledUsec: fields.get('throttled_usec') ?? 0 };
}

/* @internal */
export function buildMemoryMax(memoryMib: number): string {
  const overhead = Math.max(
    MEMORY_MIN_OVERHEAD_MIB,
    Math.ceil(memoryMib / MEMORY_OVERHEAD_DIVISOR),
  );

  return String((memoryMib + overhead) * BYTES_PER_MIB);
}

/* @internal */
export function parseOomKills(text: string): number | null {
  const match = /^oom_kill (?<count>\d+)$/mu.exec(text);

  return match?.groups === undefined ? null : Number(match.groups['count']);
}

export function createCpuCgroups(options: CpuCgroupOptions): CpuCgroups {
  const imps = join(options.root, 'imps');
  const procRoot = options.procRoot ?? '/proc';
  const rmdir = options.rmdir ?? rmdirSync;
  const sleep = options.sleep ?? Bun.sleep;
  const isEnforced = probeControllerDelegated(imps, 'cpu');
  const isMemoryEnforced = isEnforced && probeControllerDelegated(imps, 'memory');
  const getDir = (impId: string): string => join(imps, impId);

  const guestMibs = new Map<string, number>();
  const oomBaselines = new Map<string, number>();

  const readOomKills = (impId: string): number | null => {
    try {
      const events = readFileSync(join(getDir(impId), 'memory.events'), 'utf8');

      return parseOomKills(events);
    } catch {
      return null;
    }
  };

  const setOomBaseline = (impId: string): void => {
    oomBaselines.set(impId, readOomKills(impId) ?? 0);
  };

  const writeSettings = (impId: string, cpu: CpuSettings, limit: number | null): void => {
    writeFileSync(join(getDir(impId), 'cpu.weight'), String(cpu.weight));
    writeFileSync(join(getDir(impId), 'cpu.max'), formatCpuMax(limit));
  };

  // memory.high stays at max: its throttling halved a guest's disk throughput
  const writeMemory = (impId: string): void => {
    const guestMib = guestMibs.get(impId);

    if (!isMemoryEnforced || guestMib === undefined) {
      return;
    }

    const directory = getDir(impId);

    writeFileSync(join(directory, 'memory.max'), buildMemoryMax(guestMib));
    writeFileSync(join(directory, 'memory.high'), 'max');
    writeFileSync(join(directory, 'memory.swap.max'), '0');
    writeFileSync(join(directory, 'memory.oom.group'), '1');
  };

  const setup = (impId: string, cpu: CpuSettings, memoryMib: number): ImpCgroup | null => {
    if (!isEnforced) {
      return null;
    }

    try {
      if (!guestMibs.has(impId)) {
        guestMibs.set(impId, memoryMib);
      }

      mkdirSync(getDir(impId), { recursive: true });
      setOomBaseline(impId);
      writeSettings(impId, cpu, cpu.limit);
      writeMemory(impId);
    } catch (error) {
      getImpdLogger('cgroup').warning('cgroup {impId}: {error}; this VM runs unlimited', {
        impId,
        error: getErrorMessage(error),
      });

      return null;
    }

    return {
      procsPath: join(getDir(impId), 'cgroup.procs'),
      liftLimit: () => {
        tryWrite(impId, 'lift the limit', () => {
          writeSettings(impId, cpu, null);
        });
      },
      applyLimit: () => {
        tryWrite(impId, 'apply the limit', () => {
          writeSettings(impId, cpu, cpu.limit);
        });
      },
    };
  };

  return {
    isEnforced,
    isMemoryEnforced,
    setup,
    apply: (impId, cpu) => {
      if (isEnforced && existsSync(getDir(impId))) {
        tryWrite(impId, 'apply the limit', () => {
          writeSettings(impId, cpu, cpu.limit);
        });
      }
    },
    adopt: (impId, pid, cpu, memoryMib) => {
      if (!isEnforced) {
        return;
      }

      if (readProcessCgroup(pid, procRoot) === `/imps/${impId}`) {
        setOomBaseline(impId);

        return;
      }

      const cgroup = setup(impId, cpu, memoryMib);

      if (cgroup !== null) {
        tryWrite(impId, `move pid ${String(pid)}`, () => {
          writeFileSync(cgroup.procsPath, String(pid));
        });
      }
    },
    setGuestMib: (impId, guestMib) => {
      guestMibs.set(impId, guestMib);

      if (isMemoryEnforced && existsSync(getDir(impId))) {
        tryWrite(impId, 'set the memory limit', () => {
          writeMemory(impId);
        });
      }
    },
    remove: async (impId) => {
      guestMibs.delete(impId);
      oomBaselines.delete(impId);

      if (!isEnforced) {
        return;
      }

      for (let attempt = 1; existsSync(getDir(impId)); attempt += 1) {
        try {
          rmdir(getDir(impId));

          return;
        } catch (error) {
          if (!isBusy(error) || attempt === REMOVE_TRIES) {
            getImpdLogger('cgroup').warning('cgroup {impId}: remove: {error}', {
              impId,
              error: getErrorMessage(error),
            });

            return;
          }
        }

        await sleep(REMOVE_WAIT_MS);
      }
    },
    removeOrphans: (impIds) => {
      if (!isEnforced) {
        return [];
      }

      const orphans = readdirSync(imps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !impIds.has(entry.name))
        .map((entry) => entry.name);

      for (const impId of orphans) {
        tryWrite(impId, 'remove an orphan', () => {
          rmdirSync(getDir(impId));
        });
      }

      return orphans;
    },
    kill: (impId) => {
      if (isEnforced && existsSync(getDir(impId))) {
        tryWrite(impId, 'kill', () => {
          writeFileSync(join(getDir(impId), 'cgroup.kill'), '1');
        });
      }
    },
    readOomKills,
    probeOomKillSinceStart: (impId) => {
      const baseline = oomBaselines.get(impId);

      return baseline !== undefined && (readOomKills(impId) ?? 0) > baseline;
    },
    readCpuStat: (impId) => {
      try {
        const stat = readFileSync(join(getDir(impId), 'cpu.stat'), 'utf8');

        return parseCpuStat(stat);
      } catch {
        return null;
      }
    },
  };
}

function probeControllerDelegated(imps: string, controller: string): boolean {
  try {
    const delegated = readFileSync(join(imps, 'cgroup.subtree_control'), 'utf8');

    return delegated.split(/\s+/u).includes(controller);
  } catch {
    return false;
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EBUSY';
}

function tryWrite(impId: string, what: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    getImpdLogger('cgroup').warning('cgroup {impId}: {what}: {error}', {
      impId,
      what,
      error: getErrorMessage(error),
    });
  }
}
