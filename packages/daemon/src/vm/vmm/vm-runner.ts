import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { stopPid } from '../../platform/process/proc';
import { runCommand } from '../../platform/process/run-command';
import { VM_DEADLINES } from '../../platform/process/vm-deadlines';
import { writeToDisk } from '../../platform/process/write-file-durably';
import { sendGrow, sendPing, sendResumed, sendShutdown } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import { createOwnedFile } from '../files/vm-files';
import type { ImpPaths, SnapshotPaths } from '../storage/data-layout';
import { buildBootArgs } from './build-boot-args';
import type { VmPlan } from './build-boot-args';
import { VM_DEVICES, createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import { BLOCK_MIB, SLOT_MIB, getRegionMib } from './elastic-memory';
import { createFirecrackerClient } from './firecracker-client';
import type {
  CreateFirecrackerClient,
  HotplugState,
  HugePages,
  InstanceState,
  LoadOptions,
} from './firecracker-client';
import type { FoundVm, VmOwner } from './firecracker-process';
import {
  buildFirecrackerCommand,
  listFirecrackers,
  probeProcessAlive,
  readLogTail,
  readPidFile,
  readVmOwner,
  startFirecracker,
  waitForExit,
} from './firecracker-process';
import { setupSnapshotFile } from './jail';
import type { JailUser, Jails } from './jail';
import { createTemplateVm, loadTemplateVm } from './template-vm';
import type { TemplateBuildPlan, TemplateRestorePlan } from './template-vm';
import {
  buildServedFilePath,
  createUffdWatch,
  explainUffdFailure,
  readHandlerState,
  removeUffdFiles,
  requireHandlerBin,
  startUffdHandler,
  stopUffdHandler,
} from './uffd-handler';
import { writeSnapshotBase } from './write-snapshot-base';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const WAKE_AGENT_DEADLINE_MS = 10_000;

// the memory controller asks every 500 ms: a VM that does not answer soon is
// asked again on the next tick
const GUEST_MEMORY_TIMEOUTS = { requestMs: 1000, snapshotMs: 1000 };

// a sleep asks under the imp's lock: a wedged agent must not hold it long
const UPTIME_PING_TIMEOUT_MS = 250;

export interface GuestMemory extends HotplugState {
  readonly totalMib: number;
  readonly availableMib: number;
}

export interface StartedVm {
  readonly pid: number;
  readonly hugePages: HugePages;
  readonly firecrackerVersion: string;
  readonly agentVersion: string;
  readonly timings: Readonly<Record<string, number>>;
  readonly guestSteps?: Readonly<Record<string, number>> | undefined;
  readonly identityReset?: string | undefined;
  readonly bootId?: string | undefined;
}

interface WakePlan {
  readonly firecrackerBin: string;
  readonly paths: ImpPaths;
  readonly cgroup: ImpCgroup | null;
  readonly jail: JailUser | null;
  readonly readOnlyFiles: readonly string[];

  // 2M restores through a page handler, None restores a 2 MiB snapshot on the
  // host's pages, and a plan without it restores on the page size the snapshot
  // recorded
  readonly hugePages?: HugePages;
}

interface FinishedWake {
  readonly agentVersion: string;
  readonly firecrackerVersion: string;
  readonly bootId?: string | undefined;
}

export interface VmRunner {
  readonly startVm: (plan: VmPlan) => Promise<StartedVm>;
  readonly sleepVm: (
    pid: number,
    paths: ImpPaths,
    cgroup: ImpCgroup | null,
    target: SnapshotPaths,
  ) => Promise<Readonly<Record<string, number>>>;
  readonly wakeVm: (plan: WakePlan) => Promise<StartedVm>;
  readonly stopVm: (pid: number, paths: ImpPaths, graceful: boolean) => Promise<void>;
  readonly releaseVm: (paths: ImpPaths) => Promise<void>;
  readonly removeJail: (paths: ImpPaths) => Promise<void>;
  readonly removeOrphanJails: (impIds: ReadonlySet<string>) => Promise<string[]>;
  readonly probeVmAlive: (pid: number, paths: ImpPaths) => boolean;
  readonly probeAgentReady: (paths: ImpPaths, deadlineMs?: number) => Promise<boolean>;
  readonly readGuestUptimeMs: (paths: ImpPaths) => Promise<number | null>;
  readonly growDrive: (paths: ImpPaths, diskBytes: number) => Promise<void>;
  readonly readVmState: (paths: ImpPaths) => Promise<InstanceState | null>;
  readonly resumeVm: (pid: number, paths: ImpPaths) => Promise<void>;
  readonly readPid: (paths: ImpPaths) => number | null;
  readonly listVms: () => readonly FoundVm[];
  readonly readVmOwner: (pid: number) => VmOwner;
  readonly finishWake: (paths: ImpPaths) => Promise<FinishedWake>;
  readonly createTemplateVm: (plan: TemplateBuildPlan) => Promise<void>;
  readonly loadTemplateVm: (plan: TemplateRestorePlan) => Promise<StartedVm>;
  readonly readGuestMemory: (paths: ImpPaths) => Promise<GuestMemory>;
  readonly requestPluggedMib: (paths: ImpPaths, mib: number) => Promise<void>;

  // a VM that impd did not start in this run, such as one it adopts
  readonly watchUffdHandler: (pid: number, paths: ImpPaths) => void;
}

export interface VmRunnerOptions {
  readonly mergeWrapper?: string | null;
  readonly uffdHandlerBin?: string | null;
  readonly sendUptimePing?: typeof sendPing;
  readonly procRoot?: string;
  readonly createClient?: CreateFirecrackerClient;
}

export function createVmRunner(jails: Jails, options: Readonly<VmRunnerOptions> = {}): VmRunner {
  const mergeWrapper = options.mergeWrapper ?? null;
  const sendUptimePing = options.sendUptimePing ?? sendPing;
  const procRoot = options.procRoot ?? '/proc';
  const createClient = options.createClient ?? createFirecrackerClient;
  const uffdHandlerBin = options.uffdHandlerBin ?? null;
  const uffdWatch = createUffdWatch(procRoot);
  const templates = { mergeWrapper, createClient, uffdHandlerBin, uffdWatch };
  const removeVmMounts = (paths: ImpPaths): Promise<void> => jails.release(paths.impId);

  const setupVmCommand = async (
    bin: string,
    paths: ImpPaths,
    jail: JailUser | null,
    readOnlyFiles: readonly string[],
  ): Promise<readonly string[]> => {
    if (jail !== null) {
      return jails.prepare({ impId: paths.impId, user: jail, paths, readOnlyFiles });
    }

    await jails.sweepRunDir(paths);

    return buildFirecrackerCommand(bin, paths.apiSocket);
  };

  const startVmProcess = async (
    command: () => Promise<readonly string[]>,
    paths: ImpPaths,
    cgroup: ImpCgroup | null,
  ): Promise<number> => {
    try {
      const argv = await command();

      removeUffdFiles(paths);

      return await startFirecracker(argv, paths, cgroup?.procsPath ?? null, mergeWrapper);
    } catch (error) {
      await removeVmMounts(paths);

      throw error;
    }
  };

  const stopVmNow = async (pid: number, paths: ImpPaths): Promise<boolean> => {
    stopPid(pid);

    const exited = await waitForExit(pid, paths.apiSocket, VM_DEADLINES.killMs, { procRoot });

    if (exited) {
      await removeVmMounts(paths);
    }

    return exited;
  };

  const stopVm = async (pid: number, paths: ImpPaths, graceful: boolean): Promise<void> => {
    if (!probeProcessAlive(pid, paths.apiSocket, procRoot)) {
      await removeVmMounts(paths);

      return;
    }

    if (graceful) {
      try {
        await sendShutdown(paths.vsockSocket);

        const exited = await waitForExit(pid, paths.apiSocket, SHUTDOWN_TIMEOUT_MS, { procRoot });

        if (exited) {
          await removeVmMounts(paths);

          return;
        }
      } catch {
        // the agent is gone or hung; kill below
      }
    }

    const killed = await stopVmNow(pid, paths);

    if (!killed) {
      throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
    }
  };

  return {
    startVm: async (plan) => {
      const timer = createMarks();
      const setMark = timer.setMark;

      const readArgv = () =>
        setupVmCommand(plan.firecrackerBin, plan.paths, plan.jail, [
          plan.kernelPath,
          plan.systemDrivePath,
        ]);

      const pid = await startVmProcess(readArgv, plan.paths, plan.cgroup);

      setMark('spawn');

      try {
        const api = createClient(plan.paths.apiSocket);
        const versionPromise = api.readVersion();

        await setupVm(api, {
          kernelPath: plan.kernelPath,
          bootArgs: buildBootArgs(plan),
          vcpus: plan.vcpus,
          memoryMib: plan.memoryMib,
          hugePages: plan.hugePages ?? 'None',
          diskPath: plan.paths.disk,
          systemDrivePath: plan.systemDrivePath,
          vsockPath: plan.paths.vsockSocket,
          tap: plan.address.tap,
          guestMac: plan.address.guestMac,
        });

        const regionMib = getRegionMib(plan.memoryMib, plan.maxMemoryMib);

        if (regionMib > 0) {
          await api.putHotplugMemory({
            totalSizeMib: regionMib,
            slotSizeMib: SLOT_MIB,
            blockSizeMib: BLOCK_MIB,
          });
        }

        const firecrackerVersion = await versionPromise;

        setMark('configure');

        jails.seal(plan.paths, pid);

        await api.instanceStart();

        setMark('instanceStart');

        const ping = await waitForAgent(plan.paths.vsockSocket, {
          deadlineMs: VM_DEADLINES.agentMs,
        });

        setMark('agent');

        return {
          pid,
          hugePages: plan.hugePages ?? 'None',
          firecrackerVersion,
          agentVersion: ping.version,
          timings: timer.marks,
          guestSteps: Object.fromEntries(
            ping.bootSteps.map((bootStep) => [bootStep.name, bootStep.ms]),
          ),
          identityReset: ping.identityReset,
          bootId: ping.bootId,
        };
      } catch (error) {
        await stopVmNow(pid, plan.paths);

        // the disk stays open until the process is gone: a retry must not
        // put a second VM on it
        await waitForExit(pid, plan.paths.apiSocket, VM_DEADLINES.killMs, { procRoot });

        const reason = getErrorMessage(error);

        throw new Error(`boot failed: ${reason}\n${readLogTail(plan.paths.logFile)}`, {
          cause: error,
        });
      }
    },
    sleepVm: async (pid, paths, cgroup, target) => {
      const timer = createMarks();
      const setMark = timer.setMark;
      const api = createClient(paths.apiSocket);
      const files = { snapshotPath: `${target.vmstate}.new`, memFilePath: `${target.memFile}.new` };
      const owner = lstatSync(paths.disk);
      const handler = readHandlerState(paths, procRoot);

      // with no handler, the snapshot's untouched pages would read as zeros
      if (handler.state === 'gone') {
        throw new Error('its page handler is gone, so its memory cannot be read');
      }

      mkdirSync(target.snapshotDir, { recursive: true });
      createOwnedFile(files.snapshotPath, owner);
      createOwnedFile(files.memFilePath, owner);
      cgroup?.liftLimit();

      const base = await writeSnapshotBase(
        api,
        {
          memFile: paths.memFile,
          servedFile: handler.state === 'alive' ? buildServedFilePath(handler.pid, procRoot) : null,
        },
        files.memFilePath,
      );

      if (base.step !== null) {
        setMark(base.step);
      }

      const type = base.type;

      // a pause that times out may still land: resume or kill either way
      try {
        await api.pause();

        setMark('pause');

        await api.createSnapshot(files, type);
      } catch (error) {
        rmSync(files.snapshotPath, { force: true });
        rmSync(files.memFilePath, { force: true });

        // a snapshot that failed late may have cleared the dirty page log: with
        // no file to copy, the next sleep takes a Full; the VM keeps its mapping
        rmSync(paths.memFile, { force: true });

        try {
          await api.resume();

          cgroup?.applyLimit();
        } catch {
          await stopVmNow(pid, paths);
        }

        throw error;
      }

      setMark('snapshot');

      if (!(await stopVmNow(pid, paths))) {
        throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
      }

      setMark('kill');

      for (const file of [files.snapshotPath, files.memFilePath]) {
        setupSnapshotFile(file, owner.gid);
      }

      // never write into the old mem file: a restored VM mapped it MAP_PRIVATE
      renameSync(files.snapshotPath, target.vmstate);
      renameSync(files.memFilePath, target.memFile);
      rmSync(paths.apiSocket, { force: true });
      rmSync(paths.vsockSocket, { force: true });

      // zero pages become holes: a 2 GiB file with 300 MiB in use takes 381
      // MiB; the snapshot is good without it, so a failure only costs disk
      const dug = await runCommand(['fallocate', '--dig-holes', target.memFile]);

      const digStep = dug.exitCode === 0 ? 'digHoles' : 'digHolesFailed';

      setMark(digStep);

      // the snapshot metadata written after this vouches for these files, so
      // they reach the disk first
      writeToDisk([target.vmstate, target.memFile, target.snapshotDir]);
      setMark('flush');

      return timer.marks;
    },
    wakeVm: async (plan) => {
      const timer = createMarks();
      const setMark = timer.setMark;

      plan.cgroup?.liftLimit();

      // a stale vsock socket fails Firecracker's snapshot load, and the spawn
      // removes it
      const readArgv = () =>
        setupVmCommand(plan.firecrackerBin, plan.paths, plan.jail, plan.readOnlyFiles);

      const pid = await startVmProcess(readArgv, plan.paths, plan.cgroup).catch(
        (error: unknown) => {
          plan.cgroup?.applyLimit();
          throw error;
        },
      );

      setMark('spawn');

      try {
        const api = createClient(plan.paths.apiSocket);
        const isUffd = plan.hugePages === '2M';

        if (isUffd) {
          await startUffdHandler({
            handlerBin: requireHandlerBin(uffdHandlerBin),
            paths: plan.paths,
            memFile: plan.paths.memFile,
            jail: plan.jail,
            cgroup: plan.cgroup,
          });

          uffdWatch.watch(pid, plan.paths);

          setMark('handler');
        }

        // the load binds the vsock socket, so the jail's seal waits for the load
        // and lands before the guest runs; KVM's dirty log maps a 2 MiB guest
        // in 4 KiB pages, which takes away what its huge pages gain
        const loadOptions: LoadOptions = isUffd
          ? { resumeVm: false, uffdSocket: plan.paths.uffdSocket, hugePages: '2M' }
          : {
              resumeVm: false,
              isTrackingDirtyPages: true,
              ...(plan.hugePages === 'None' && { hugePages: 'None' }),
            };

        await api.loadSnapshot(
          { snapshotPath: plan.paths.vmstate, memFilePath: plan.paths.memFile },
          loadOptions,
        );

        jails.seal(plan.paths, pid);

        await api.resume();

        plan.cgroup?.applyLimit();
        setMark('load');

        // a ping sent while the guest resumes can hang: retry it soon
        const ping = await waitForAgent(plan.paths.vsockSocket, {
          deadlineMs: WAKE_AGENT_DEADLINE_MS,
          attemptMs: 200,
        });

        setMark('agent');

        await sendResumed(plan.paths.vsockSocket, Date.now());

        const firecrackerVersion = await api.readVersion();

        setMark('resumed');

        return {
          pid,
          hugePages: plan.hugePages ?? 'None',
          firecrackerVersion,
          agentVersion: ping.version,
          timings: timer.marks,
          bootId: ping.bootId,
        };
      } catch (error) {
        const reason = explainUffdFailure(plan.paths, procRoot, getErrorMessage(error));

        await stopVmNow(pid, plan.paths);

        stopUffdHandler(plan.paths, procRoot);
        plan.cgroup?.applyLimit();

        throw new Error(`wake failed: ${reason}\n${readLogTail(plan.paths.logFile, 5)}`, {
          cause: error,
        });
      }
    },
    stopVm,
    releaseVm: removeVmMounts,
    removeJail: (paths) => jails.remove(paths.impId),
    removeOrphanJails: jails.removeOrphans,
    growDrive: async (paths, diskBytes) => {
      await createClient(paths.apiSocket).patchDrive(VM_DEVICES.drives.rootfs, paths.disk);
      await sendGrow(paths.vsockSocket, diskBytes);
    },
    readGuestMemory: async (paths) => {
      const api = createClient(paths.apiSocket, GUEST_MEMORY_TIMEOUTS);

      const [hotplug, stats] = await Promise.all([api.readHotplugMemory(), api.readBalloonStats()]);

      return { ...hotplug, ...stats };
    },
    requestPluggedMib: async (paths, mib) => {
      await createClient(paths.apiSocket, GUEST_MEMORY_TIMEOUTS).patchHotplugMemory(mib);
    },
    probeVmAlive: (pid, paths) => probeProcessAlive(pid, paths.apiSocket, procRoot),
    probeAgentReady: async (paths, deadlineMs = 2000) => {
      try {
        await waitForAgent(paths.vsockSocket, { deadlineMs });

        return true;
      } catch {
        return false;
      }
    },
    readGuestUptimeMs: async (paths) => {
      try {
        const answer = await sendUptimePing(paths.vsockSocket, UPTIME_PING_TIMEOUT_MS);

        return answer.uptimeMs ?? null;
      } catch {
        return null;
      }
    },
    readVmState: async (paths) => {
      try {
        return await createClient(paths.apiSocket).readInstanceState();
      } catch {
        return null;
      }
    },
    resumeVm: async (pid, paths) => {
      // a wake cut short between the load and its seal: seal before the guest
      // runs, and kill a VM that left anything in run/
      try {
        jails.seal(paths, pid);
      } catch (error) {
        await stopVmNow(pid, paths);

        throw error;
      }

      await createClient(paths.apiSocket).resume();
    },
    readPid: (paths) => readPidFile(paths.pidFile),
    listVms: () => listFirecrackers(procRoot),
    readVmOwner: (pid) => readVmOwner(pid, procRoot),
    finishWake: async (paths) => {
      const ping = await waitForAgent(paths.vsockSocket, {
        deadlineMs: WAKE_AGENT_DEADLINE_MS,
        attemptMs: 200,
      });

      await sendResumed(paths.vsockSocket, Date.now());

      const firecrackerVersion = await createClient(paths.apiSocket).readVersion();

      return { agentVersion: ping.version, firecrackerVersion, bootId: ping.bootId };
    },
    createTemplateVm: (plan) => createTemplateVm(plan, jails, templates),
    loadTemplateVm: (plan) => loadTemplateVm(plan, jails, templates),
    watchUffdHandler: uffdWatch.watch,
  };
}
