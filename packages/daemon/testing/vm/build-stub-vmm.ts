import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { buildAgentOutdatedError } from '../../src/vm/agent-client/agent-outdated';
import { readLoadingMeta } from '../../src/vm/sleep/snapshot-meta';
import type { FirecrackerPaths, ImpPaths } from '../../src/vm/storage/data-layout';
import type { InstanceState } from '../../src/vm/vmm/firecracker-client';
import type { VmOwner } from '../../src/vm/vmm/firecracker-process';
import type { JailUser } from '../../src/vm/vmm/jail';
import { TemplateRestoreError } from '../../src/vm/vmm/template-vm';
import type { TemplateRestorePlan } from '../../src/vm/vmm/template-vm';
import type { VmRunner } from '../../src/vm/vmm/vm-runner';

export const STUB_AGENT_VERSION = '0.1.0';
const IMPD_OWNER: VmOwner = { uid: process.getuid?.() ?? 0, cgroup: null };

export type VmStep =
  | 'boot'
  | 'wake'
  | 'sleep'
  | 'stop'
  | 'agentReady'
  | 'grow'
  | 'vmState'
  | 'resume'
  | 'plug'
  | 'template'
  | 'restore'
  | 'claim';

export type VmOutcome = 'ok' | 'fail' | 'die' | 'hang';

export class StubVmError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'StubVmError';
  }
}

interface Hold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

export function buildStubBootId(pid: number): string {
  return `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`;
}

interface FakeGuestMemory {
  baseMib: number;
  pluggedMib: number;
  requestedMib: number;
  usedMib: number;

  unplugFloorMib: number;
}

// Firecracker processes outlive impd, so every impd a test starts shares one
// set of live VMs.
export function buildStubVmm() {
  const alive = new Set<number>();

  const agent = { version: STUB_AGENT_VERSION };

  const vms = new Map<number, { apiSocket: string; state: InstanceState; owner: VmOwner }>();
  const pidFiles = new Map<string, number>();

  const wakes: number[] = [];

  const bootIds = new Map<string, string>();

  const stops: { pid: number; graceful: boolean }[] = [];
  const grows: { disk: string; diskBytes: number }[] = [];
  const boots: { hostname: string; isIdentityReset: boolean }[] = [];
  const templateBuilds: { vcpus: number; memoryMib: number }[] = [];
  const restores: { hostname: string; isIdentityReset: boolean; memFile: string }[] = [];
  const sweeps: string[] = [];

  const orphanJails = new Set<string>();

  const restorePlans: TemplateRestorePlan[] = [];
  const wakeJails: { jail: JailUser | null; files: string[] }[] = [];

  const usedSnapshots = new Set<string>();

  const counter = { nextPid: 1000, generation: 0 };

  const guest = {
    uptimeMs: 60_000,
    identityReset: 'ok' as 'ok' | 'failed' | undefined,
    hasBootId: true,
    bootSteps: {} as Readonly<Record<string, number>>,
  };

  const guestMemory = new Map<string, FakeGuestMemory>();

  const readFakeGuestMemory = (directory: string): FakeGuestMemory => {
    const known = guestMemory.get(directory);

    if (known !== undefined) {
      return known;
    }

    const created = {
      baseMib: 512,
      pluggedMib: 0,
      requestedMib: 0,
      usedMib: 100,
      unplugFloorMib: 0,
    };

    guestMemory.set(directory, created);

    return created;
  };

  const queues = new Map<VmStep, VmOutcome[]>();
  const holds = new Map<VmStep, { gate: PromiseWithResolvers<void>; reached: () => void }>();

  const hangs = { gate: Promise.withResolvers<void>() };
  const waiting = { hung: 0, parked: 0 };

  const parkedBuilds = new WeakMap<VmRunner, Promise<void>>();

  const pacer: { pace: (step: VmStep) => Promise<void> } = { pace: () => Promise.resolve() };

  const chooseOutcome = async (step: VmStep): Promise<Exclude<VmOutcome, 'hang'>> => {
    const hold = holds.get(step);

    if (hold !== undefined) {
      hold.reached();

      await hold.gate.promise;
    }

    await pacer.pace(step);

    const outcome = queues.get(step)?.shift() ?? 'ok';

    if (outcome !== 'hang') {
      return outcome;
    }

    waiting.hung += 1;

    await hangs.gate.promise;

    waiting.hung -= 1;

    return 'ok';
  };

  const startPid = (): number => {
    counter.nextPid += 1;

    return counter.nextPid;
  };

  const setVm = (
    pid: number,
    paths: Readonly<FirecrackerPaths>,
    state: InstanceState,
    owner: VmOwner = IMPD_OWNER,
  ): void => {
    alive.add(pid);
    vms.set(pid, { apiSocket: paths.apiSocket, state, owner });
  };

  const findServing = (paths: Readonly<ImpPaths>) => {
    const serving = [...vms].filter(
      ([pid, vm]) => alive.has(pid) && vm.apiSocket === paths.apiSocket,
    );

    return serving.at(-1)?.[1];
  };

  const buildRunner = (generation: number): VmRunner => {
    const parkedBuild = Promise.withResolvers<void>();

    const waitForever = <T>(onPark?: () => void): Promise<T> => {
      waiting.parked += 1;
      onPark?.();

      return new Promise<T>(() => {});
    };

    const runInGeneration = async <T>(call: () => Promise<T>, onPark?: () => void): Promise<T> => {
      if (generation !== counter.generation) {
        return waitForever(onPark);
      }

      const settled = await call().then(
        (value) => ({ isOk: true as const, value }),
        (error: unknown) => ({ isOk: false as const, error }),
      );

      if (generation !== counter.generation) {
        return waitForever(onPark);
      }

      if (!settled.isOk) {
        throw settled.error;
      }

      return settled.value;
    };

    const withGeneration = <T>(read: () => T): T => {
      if (generation !== counter.generation) {
        throw new Error('this impd was replaced');
      }

      return read();
    };

    const startFakeVm = async (
      step: 'boot' | 'wake' | 'restore',
      paths: Readonly<FirecrackerPaths>,
    ) => {
      const outcome = await chooseOutcome(step);

      if (outcome === 'fail') {
        throw new StubVmError(`${step} failed: no agent\nlog tail`);
      }

      const pid = startPid();

      pidFiles.set(paths.pidFile, pid);

      if (outcome === 'ok') {
        setVm(pid, paths, 'Running');
      }

      return { pid, firecrackerVersion: 'v1.17.0', agentVersion: agent.version, timings: {} };
    };

    const runner: VmRunner = {
      startVm: (plan) =>
        runInGeneration(async () => {
          boots.push({ hostname: plan.hostname, isIdentityReset: plan.isIdentityReset });

          const started = await startFakeVm('boot', plan.paths);

          const bootId = guest.hasBootId ? buildStubBootId(started.pid) : undefined;
          const vm = { ...started, bootId, guestSteps: guest.bootSteps };

          if (bootId !== undefined) {
            bootIds.set(plan.paths.apiSocket, bootId);
          }

          return plan.isIdentityReset ? { ...vm, identityReset: guest.identityReset } : vm;
        }),
      wakeVm: (plan) =>
        runInGeneration(async () => {
          const files = [plan.paths.disk, plan.paths.vmstate, plan.paths.memFile];

          wakeJails.push({ jail: plan.jail, files: files.filter((file) => existsSync(file)) });

          // A jailed Firecracker sees only what its jail binds, and the load
          // reopens the drive the snapshot names: without it the load fails
          // before the guest runs.
          const drive = readLoadingMeta(plan.paths)?.systemDrivePath;

          if (plan.jail !== null && drive !== undefined && !plan.readOnlyFiles.includes(drive)) {
            throw new StubVmError(`wake failed: the jail has no ${drive}`);
          }

          try {
            const vm = await startFakeVm('wake', plan.paths);

            wakes.push(vm.pid);

            return { ...vm, bootId: bootIds.get(plan.paths.apiSocket) };
          } finally {
            usedSnapshots.add(plan.paths.snapshotDir);
          }
        }),
      sleepVm: (pid, _paths, _cgroup, target) =>
        runInGeneration(async () => {
          const vm = vms.get(pid);

          if (vm !== undefined) {
            vm.state = 'Paused';
          }

          const outcome = await chooseOutcome('sleep');

          if (outcome === 'fail') {
            if (vm !== undefined) {
              vm.state = 'Running';
            }

            throw new StubVmError('snapshot failed');
          }

          alive.delete(pid);

          if (outcome === 'die') {
            throw new StubVmError('snapshot files lost after the kill');
          }

          mkdirSync(target.snapshotDir, { recursive: true });
          writeFileSync(`${target.vmstate}.new`, 'vmstate');
          writeFileSync(`${target.memFile}.new`, 'mem');
          renameSync(`${target.vmstate}.new`, target.vmstate);
          renameSync(`${target.memFile}.new`, target.memFile);

          usedSnapshots.delete(target.snapshotDir);

          return {};
        }),
      releaseVm: () => runInGeneration(() => Promise.resolve()),
      removeJail: () => runInGeneration(() => Promise.resolve()),
      removeOrphanJails: (impIds) =>
        runInGeneration(() => {
          sweeps.push('jails');

          const removed = [...orphanJails].filter((impId) => !impIds.has(impId));

          for (const impId of removed) {
            orphanJails.delete(impId);
          }

          return Promise.resolve(removed);
        }),
      stopVm: (pid, _paths, graceful) =>
        runInGeneration(async () => {
          const outcome = await chooseOutcome('stop');

          if (outcome !== 'ok' && alive.has(pid)) {
            throw new StubVmError(`firecracker ${String(pid)} survived SIGKILL`);
          }

          alive.delete(pid);
          stops.push({ pid, graceful });
        }),
      probeVmAlive: (pid) => withGeneration(() => alive.has(pid)),

      growDrive: (paths, diskBytes) =>
        runInGeneration(async () => {
          const outcome = await chooseOutcome('grow');

          if (outcome === 'die') {
            throw buildAgentOutdatedError('grow');
          }

          if (outcome !== 'ok') {
            throw new StubVmError('grow failed');
          }

          grows.push({ disk: paths.disk, diskBytes });
        }),
      probeAgentReady: () =>
        runInGeneration(async () => {
          const outcome = await chooseOutcome('agentReady');

          return outcome === 'ok';
        }),
      readGuestUptimeMs: () => runInGeneration(() => Promise.resolve(guest.uptimeMs)),

      readVmState: (paths) =>
        runInGeneration(async () => {
          const outcome = await chooseOutcome('vmState');

          return outcome === 'ok' ? (findServing(paths)?.state ?? null) : null;
        }),
      resumeVm: (_pid, paths) =>
        runInGeneration(async () => {
          if ((await chooseOutcome('resume')) !== 'ok') {
            throw new StubVmError('resume failed');
          }

          const vm = findServing(paths);

          if (vm !== undefined) {
            vm.state = 'Running';
          }
        }),
      readPid: (paths) => withGeneration(() => pidFiles.get(paths.pidFile) ?? null),
      listVms: () =>
        withGeneration(() =>
          [...vms]
            .filter(([pid]) => alive.has(pid))
            .map(([pid, vm]) => ({ pid, apiSocket: vm.apiSocket, owner: vm.owner })),
        ),
      readVmOwner: (pid) => withGeneration(() => vms.get(pid)?.owner ?? IMPD_OWNER),
      finishWake: (paths) =>
        runInGeneration(async () => {
          const outcome = await chooseOutcome('agentReady');

          if (outcome !== 'ok') {
            throw new StubVmError('the agent did not answer after the load');
          }

          return {
            agentVersion: agent.version,
            firecrackerVersion: 'v1.17.0',
            bootId: bootIds.get(paths.apiSocket),
          };
        }),

      createTemplateVm: (plan) =>
        runInGeneration(async () => {
          const outcome = await chooseOutcome('template');

          if (outcome !== 'ok') {
            throw new StubVmError('template build failed');
          }

          mkdirSync(plan.snapshotDir, { recursive: true });
          writeFileSync(plan.vmstate, 'vmstate');
          writeFileSync(plan.memFile, 'mem');

          templateBuilds.push({ vcpus: plan.vcpus, memoryMib: plan.memoryMib });
        }, parkedBuild.resolve),

      loadTemplateVm: (plan) =>
        runInGeneration(async () => {
          restorePlans.push(plan);

          const vm = await startFakeVm('restore', plan.paths).catch((error: unknown) => {
            throw new TemplateRestoreError('restore failed', true, error);
          });

          await plan.diskReady.catch((error: unknown) => {
            alive.delete(vm.pid);
            throw new TemplateRestoreError('disk failed', false, error);
          });

          if ((await chooseOutcome('claim')) !== 'ok') {
            alive.delete(vm.pid);
            throw new TemplateRestoreError('claim failed', false, null);
          }

          restores.push({
            hostname: plan.claim.hostname,
            isIdentityReset: plan.claim.isIdentityReset,
            memFile: plan.memFile,
          });

          const claimed = { ...vm, guestSteps: guest.bootSteps };

          return plan.claim.isIdentityReset
            ? { ...claimed, identityReset: guest.identityReset }
            : claimed;
        }),
      readGuestMemory: (paths) =>
        runInGeneration(() => {
          const memory = readFakeGuestMemory(paths.directory);

          return Promise.resolve({
            pluggedMib: memory.pluggedMib,
            requestedMib: memory.requestedMib,
            totalMib: memory.baseMib + memory.pluggedMib,
            availableMib: memory.baseMib + memory.pluggedMib - memory.usedMib,
          });
        }),
      requestPluggedMib: (paths, mib) =>
        runInGeneration(async () => {
          if ((await chooseOutcome('plug')) !== 'ok') {
            throw new StubVmError('plug failed');
          }

          const memory = readFakeGuestMemory(paths.directory);

          memory.requestedMib = mib;
          memory.pluggedMib = Math.max(mib, Math.min(memory.pluggedMib, memory.unplugFloorMib));
        }),
    };

    parkedBuilds.set(runner, parkedBuild.promise);

    return runner;
  };

  return {
    alive,
    agent,
    usedSnapshots,
    wakes,
    stops,
    grows,
    boots,
    templateBuilds,
    restores,
    restorePlans,
    wakeJails,
    sweeps,
    orphanJails,

    guestMemory,

    startGeneration: (): VmRunner => {
      counter.generation += 1;

      return buildRunner(counter.generation);
    },

    whenTemplateBuildParks: (runner: VmRunner): Promise<void> =>
      parkedBuilds.get(runner) ?? Promise.reject(new Error('not a runner of this fake')),

    queue: (step: VmStep, ...outcomes: readonly VmOutcome[]) => {
      queues.set(step, [...(queues.get(step) ?? []), ...outcomes]);
    },

    clearQueues: () => {
      queues.clear();
    },

    hold: (step: VmStep): Hold => {
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();

      holds.set(step, { gate, reached: reached.resolve });

      return {
        reached: reached.promise,
        release: () => {
          holds.delete(step);
          gate.resolve();
        },
      };
    },

    countHungCalls: (): number => waiting.hung,
    countParkedCalls: (): number => waiting.parked,

    releaseHangs: () => {
      hangs.gate.resolve();

      hangs.gate = Promise.withResolvers<void>();
    },

    setGuestUptime: (uptimeMs: number) => {
      guest.uptimeMs = uptimeMs;
    },

    setGuestBootId: (hasBootId: boolean) => {
      guest.hasBootId = hasBootId;
    },

    setGuestBootSteps: (steps: Readonly<Record<string, number>>) => {
      guest.bootSteps = steps;
    },

    setIdentityReset: (result: 'ok' | 'failed' | undefined) => {
      guest.identityReset = result;
    },

    setPace: (pace: (step: VmStep) => Promise<void>) => {
      pacer.pace = pace;
    },

    spawnOrphan: (
      orphan: {
        readonly paths: Readonly<ImpPaths>;
        readonly state?: InstanceState;
        readonly pidFile?: boolean;
        readonly owner?: VmOwner;
      } | null = null,
    ): number => {
      const pid = startPid();

      alive.add(pid);

      if (orphan !== null) {
        setVm(pid, orphan.paths, orphan.state ?? 'Running', orphan.owner);

        if (orphan.pidFile ?? true) {
          pidFiles.set(orphan.paths.pidFile, pid);
        }
      }

      return pid;
    },

    setOwner: (pid: number, owner: VmOwner) => {
      const vm = vms.get(pid);

      if (vm !== undefined) {
        vm.owner = owner;
      }
    },

    readState: (pid: number): InstanceState | undefined => vms.get(pid)?.state,
  };
}
