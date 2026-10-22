import type { GuestNetBytes } from '../../host-net/net/tap-bytes';
import type { CpuStat } from '../../vm/vmm/cpu-cgroups';

// /proc/<pid>/stat counts CPU time in USER_HZ ticks, hundredths of a second.
const USEC_PER_TICK = 10_000;

interface ResourceSample {
  readonly measuredAt: Date;
  readonly since: Date;
  readonly cpuPercent?: number;
  readonly cpuThrottledMs: number;
  readonly netRxBytes: number;
  readonly netTxBytes: number;
  readonly ramMib: number | null;
  readonly rssMib: number | null;
}

export interface ResourceDelta {
  readonly intervalMs: number;
  readonly cpuPercent: number;
  readonly cpuUsec: number;
  readonly throttledUsec: number;
  readonly netRxBytes: number;
  readonly netTxBytes: number;
}

interface VmMemory {
  readonly ramMib: number | null;
  readonly rssMib: number | null;
}

interface SampledVm {
  readonly impId: string;
  readonly pid: number;
  readonly apiSocket: string;
  readonly tap: string;
}

interface SamplerReaders {
  readonly now: () => number;

  readonly readCpuStat: (impId: string) => CpuStat | null;
  readonly readCpuTicks: (pid: number) => number | null;
  readonly readNetBytes: (tap: string) => GuestNetBytes | null;

  readonly readMemory: (pid: number, apiSocket: string) => VmMemory;

  readonly readThreadIds: (pid: number) => readonly number[] | null;
}

interface Counters {
  readonly cpuUsec: number;
  readonly throttledUsec: number;
  readonly rx: number;
  readonly tx: number;
}

interface Tracked {
  readonly pid: number;
  readonly since: number;
  readonly last: Counters;
  readonly lastAt: number;
  readonly totals: Counters;
  readonly sample: ResourceSample;

  // A thread that an oops killed leaves the task list before the process dies,
  // so the set keeps every thread seen at any look.
  readonly threadIds: ReadonlySet<number>;
}

const ZERO: Counters = { cpuUsec: 0, throttledUsec: 0, rx: 0, tx: 0 };

export interface ResourceSampler {
  readonly readVmUsage: (vm: SampledVm) => ResourceDelta | null;

  readonly startCounting: (vm: SampledVm) => void;

  readonly readSample: (vm: SampledVm) => ResourceSample;

  readonly readLastSeenAt: (impId: string) => Date | null;

  readonly listThreadOwners: (threadId: number) => readonly string[];

  readonly keepOnly: (impIds: ReadonlySet<string>) => void;
}

export function createResourceSampler(readers: SamplerReaders): ResourceSampler {
  const tracked = new Map<string, Tracked>();

  const readCounters = (vm: SampledVm): Counters => {
    const stat = readers.readCpuStat(vm.impId);
    const ticks = stat === null ? readers.readCpuTicks(vm.pid) : null;
    const net = readers.readNetBytes(vm.tap);

    return {
      cpuUsec: stat?.usageUsec ?? (ticks ?? 0) * USEC_PER_TICK,
      throttledUsec: stat?.throttledUsec ?? 0,
      rx: net?.rxBytes ?? 0,
      tx: net?.txBytes ?? 0,
    };
  };

  const readVmSample = (vm: SampledVm): { entry: Tracked; delta: ResourceDelta | null } => {
    const now = readers.now();
    const counters = readCounters(vm);
    const memory = readers.readMemory(vm.pid, vm.apiSocket);
    const threads = readers.readThreadIds(vm.pid) ?? [];
    const previous = tracked.get(vm.impId);

    if (previous?.pid !== vm.pid) {
      const entry = {
        pid: vm.pid,
        since: now,
        last: counters,
        lastAt: now,
        totals: ZERO,
        sample: buildSample({ now, since: now, totals: ZERO, memory, cpuPercent: undefined }),
        threadIds: new Set(threads),
      };

      tracked.set(vm.impId, entry);

      return { entry, delta: null };
    }

    const step = {
      cpuUsec: readStep(previous.last.cpuUsec, counters.cpuUsec),
      throttledUsec: readStep(previous.last.throttledUsec, counters.throttledUsec),
      rx: readStep(previous.last.rx, counters.rx),
      tx: readStep(previous.last.tx, counters.tx),
    };

    const intervalMs = Math.max(1, now - previous.lastAt);
    const cpuPercent = (step.cpuUsec / 1000 / intervalMs) * 100;

    const totals = {
      cpuUsec: previous.totals.cpuUsec + step.cpuUsec,
      throttledUsec: previous.totals.throttledUsec + step.throttledUsec,
      rx: previous.totals.rx + step.rx,
      tx: previous.totals.tx + step.tx,
    };

    const entry = {
      pid: vm.pid,
      since: previous.since,
      last: counters,
      lastAt: now,
      totals,
      sample: buildSample({ now, since: previous.since, totals, memory, cpuPercent }),
      threadIds: new Set([...previous.threadIds, ...threads]),
    };

    tracked.set(vm.impId, entry);

    return {
      entry,
      delta: {
        intervalMs,
        cpuPercent,
        cpuUsec: step.cpuUsec,
        throttledUsec: step.throttledUsec,
        netRxBytes: step.rx,
        netTxBytes: step.tx,
      },
    };
  };

  const readVmUsage = (vm: SampledVm): ResourceDelta | null => readVmSample(vm).delta;

  return {
    readVmUsage,
    startCounting: (vm) => {
      tracked.delete(vm.impId);

      readVmUsage(vm);
    },
    readSample: (vm) => {
      const cached = tracked.get(vm.impId);

      if (cached?.pid === vm.pid) {
        return cached.sample;
      }

      return readVmSample(vm).entry.sample;
    },
    readLastSeenAt: (impId) => {
      const seen = tracked.get(impId);

      return seen === undefined ? null : new Date(seen.lastAt);
    },
    listThreadOwners: (threadId) =>
      [...tracked].filter(([, entry]) => entry.threadIds.has(threadId)).map(([impId]) => impId),
    keepOnly: (impIds) => {
      for (const impId of tracked.keys()) {
        if (!impIds.has(impId)) {
          tracked.delete(impId);
        }
      }
    },
  };
}

interface BuildSampleOptions {
  readonly now: number;
  readonly since: number;
  readonly totals: Counters;
  readonly memory: VmMemory;
  readonly cpuPercent: number | undefined;
}

function buildSample(options: BuildSampleOptions): ResourceSample {
  const cpuPercent = options.cpuPercent;

  return {
    measuredAt: new Date(options.now),
    since: new Date(options.since),
    ...(cpuPercent !== undefined && { cpuPercent: Math.round(cpuPercent * 10) / 10 }),
    cpuThrottledMs: Math.round(options.totals.throttledUsec / 1000),
    netRxBytes: options.totals.rx,
    netTxBytes: options.totals.tx,
    ramMib: options.memory.ramMib,
    rssMib: options.memory.rssMib,
  };
}

function readStep(last: number, current: number): number {
  return current >= last ? current - last : current;
}
