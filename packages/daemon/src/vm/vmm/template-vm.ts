import { mkdirSync, rmSync } from 'node:fs';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { IMPD_USER } from '../../platform/process/impd-user';
import { stopPid } from '../../platform/process/proc';
import { VM_DEADLINES } from '../../platform/process/vm-deadlines';
import { writeToDisk } from '../../platform/process/write-file-durably';
import { sendClaim, sendPing } from '../agent-client/agent-requests';
import type { Claim } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import { createOwnedFile } from '../files/vm-files';
import { waitForGuestAge } from '../sleep/guest-age';
import type { ImpPaths } from '../storage/data-layout';
import { VM_DEVICES, createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import type { UffdWatch } from './create-uffd-watch';
import { createFirecrackerClient } from './firecracker-client';
import type { CreateFirecrackerClient, HugePages, LoadOptions } from './firecracker-client';
import {
  buildFirecrackerCommand,
  readLogTail,
  startFirecracker,
  waitForExit,
} from './firecracker-process';
import { setupTemplateFile } from './jail';
import type { JailUser, Jails, RunPaths } from './jail';
import {
  explainUffdFailure,
  removeUffdFiles,
  requireHandlerBin,
  startUffdHandler,
  stopUffdHandler,
} from './uffd-handler';
import type { StartedVm } from './vm-runner';

const CLAIMED_AGENT_DEADLINE_MS = 10_000;

// a restore's agent answers within tens of ms, so it is pinged often rather
// than on a cold boot's backoff
const RESTORE_PING_DELAY_MS = 5;

export interface TemplateBuildPlan {
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly bootArgs: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly hugePages: HugePages;
  readonly workDir: string;
  readonly paths: RunPaths;
  readonly placeholderPath: string;
  readonly tap: string;
  readonly guestMac: string;
  readonly jailId: string;
  readonly jail: JailUser | null;
  readonly cgroup: ImpCgroup | null;

  // on a host kernel before 6.7, a guest snapshotted too young restores slowly
  readonly minGuestUptimeMs: number;
  readonly snapshotDir: string;
  readonly vmstate: string;
  readonly memFile: string;
}

export interface TemplateRestorePlan {
  readonly firecrackerBin: string;
  readonly paths: ImpPaths;
  readonly vmstate: string;
  readonly memFile: string;
  readonly hugePages: HugePages;
  readonly systemDrivePath: string;
  readonly placeholderPath: string;
  readonly diskPath: string;
  readonly tap: string;
  readonly cgroup: ImpCgroup | null;
  readonly jail: JailUser | null;
  readonly diskReady: Promise<number>;
  readonly claim: Omit<Claim, 'unixMs' | 'diskBytes'>;
}

export interface TemplateVmOptions {
  readonly mergeWrapper?: string | null;
  readonly createClient?: CreateFirecrackerClient;
  readonly uffdHandlerBin?: string | null;
  readonly uffdWatch?: UffdWatch;
  readonly parkedAgentMs?: number;
}

export async function createTemplateVm(
  plan: Readonly<TemplateBuildPlan>,
  jails: Jails,
  options: Readonly<TemplateVmOptions> = {},
): Promise<void> {
  try {
    await runBuildVm(plan, jails, options);

    setupTemplateFile(plan.vmstate);
    setupTemplateFile(plan.memFile);
    writeToDisk([plan.vmstate, plan.memFile, plan.snapshotDir]);
  } catch (error) {
    rmSync(plan.snapshotDir, { recursive: true, force: true });

    throw new Error(
      `template build failed: ${getErrorMessage(error)}\n${readLogTail(plan.paths.logFile)}`,
      { cause: error },
    );
  }
}

async function runBuildVm(
  plan: Readonly<TemplateBuildPlan>,
  jails: Jails,
  options: Readonly<TemplateVmOptions>,
): Promise<void> {
  try {
    const argv =
      plan.jail === null
        ? buildFirecrackerCommand(plan.firecrackerBin, plan.paths.apiSocket)
        : await jails.prepareBuild({
            id: plan.jailId,
            user: plan.jail,
            workDir: plan.workDir,
            paths: plan.paths,
            readOnlyFiles: [plan.kernelPath, plan.systemDrivePath],
            scratchFiles: [plan.placeholderPath],
          });

    const pid = await startFirecracker(
      argv,
      plan.paths,
      plan.cgroup?.procsPath ?? null,
      options.mergeWrapper ?? null,
    );

    try {
      const api = (options.createClient ?? createFirecrackerClient)(plan.paths.apiSocket);

      await setupVm(api, {
        kernelPath: plan.kernelPath,
        bootArgs: plan.bootArgs,
        vcpus: plan.vcpus,
        memoryMib: plan.memoryMib,
        hugePages: plan.hugePages,
        diskPath: plan.placeholderPath,
        systemDrivePath: plan.systemDrivePath,
        vsockPath: plan.paths.vsockSocket,
        tap: plan.tap,
        guestMac: plan.guestMac,
      });

      jails.removeUffdDevice(plan.jailId);
      jails.seal(plan.paths, pid);

      await api.instanceStart();

      await waitForAgent(plan.paths.vsockSocket, {
        deadlineMs: VM_DEADLINES.agentMs,
        isParked: true,
      });

      await waitForGuestAge({
        readUptimeMs: async () => {
          const ping = await sendPing(plan.paths.vsockSocket);

          return ping.uptimeMs ?? null;
        },
        minUptimeMs: plan.minGuestUptimeMs,
        isWanted: () => Promise.resolve(true),
      });

      await api.pause();

      const owner = plan.jail ?? IMPD_USER;

      mkdirSync(plan.snapshotDir, { recursive: true });
      createOwnedFile(plan.vmstate, owner);
      createOwnedFile(plan.memFile, owner);

      // a Full snapshot of a 2 MiB guest takes a pool page for each block it
      // never touched, and a Diff into the empty file writes only the rest
      const snapshotType = plan.hugePages === '2M' ? 'Diff' : 'Full';

      await api.createSnapshot(
        { snapshotPath: plan.vmstate, memFilePath: plan.memFile },
        snapshotType,
      );
    } finally {
      stopPid(pid);

      await waitForExit(pid, plan.paths.apiSocket, VM_DEADLINES.killMs);
    }
  } finally {
    if (plan.jail !== null) {
      await jails.release(plan.jailId);
    }
  }
}

async function startRestoreProcess(
  plan: Readonly<TemplateRestorePlan>,
  jails: Jails,
  mergeWrapper: string | null,
): Promise<number> {
  try {
    const argv = await setupRestoreCommand(plan, jails);

    removeUffdFiles(plan.paths);

    return await startFirecracker(argv, plan.paths, plan.cgroup?.procsPath ?? null, mergeWrapper);
  } catch (error) {
    await jails.release(plan.paths.impId);

    throw error;
  }
}

async function setupRestoreCommand(
  plan: Readonly<TemplateRestorePlan>,
  jails: Jails,
): Promise<readonly string[]> {
  if (plan.jail === null) {
    await jails.sweepRunDir(plan.paths);

    return buildFirecrackerCommand(plan.firecrackerBin, plan.paths.apiSocket);
  }

  return jails.prepare({
    impId: plan.paths.impId,
    user: plan.jail,
    paths: plan.paths,
    readOnlyFiles: [plan.vmstate, plan.memFile, plan.systemDrivePath],
    scratchFiles: [plan.placeholderPath],
    isDiskLate: true,
  });
}

// A load or resume failure is the template's own, and so is a parked agent that
// never answers, unless the host was too busy for it: the template store tells
// those apart. A failure after the claim is the imp's.
export type TemplateFault = 'load' | 'agent' | null;

export class TemplateRestoreError extends Error {
  readonly fault: TemplateFault;

  constructor(message: string, fault: TemplateFault, cause: unknown) {
    super(message, { cause });

    this.name = 'TemplateRestoreError';
    this.fault = fault;
  }
}

export async function loadTemplateVm(
  plan: Readonly<TemplateRestorePlan>,
  jails: Jails,
  options: Readonly<TemplateVmOptions> = {},
): Promise<StartedVm> {
  const marks = createMarks();

  const pid = await startRestoreProcess(plan, jails, options.mergeWrapper ?? null);

  marks.setMark('spawn');

  const step: { fault: TemplateFault } = { fault: 'load' };

  try {
    const api = (options.createClient ?? createFirecrackerClient)(plan.paths.apiSocket);
    const isUffd = plan.hugePages === '2M';

    if (isUffd) {
      await startUffdHandler({
        handlerBin: requireHandlerBin(options.uffdHandlerBin ?? null),
        paths: plan.paths,
        memFile: plan.memFile,
        jail: plan.jail,
        cgroup: plan.cgroup,
      });

      options.uffdWatch?.watch(pid, plan.paths);
      marks.setMark('handler');
    }

    const overrides = {
      ifaceId: VM_DEVICES.iface,
      hostDevName: plan.tap,
      vsockPath: plan.paths.vsockSocket,
    };

    const loadOptions: LoadOptions = isUffd
      ? { resumeVm: false, overrides, uffdSocket: plan.paths.uffdSocket, hugePages: '2M' }
      : { resumeVm: false, overrides };

    await api.loadSnapshot({ snapshotPath: plan.vmstate, memFilePath: plan.memFile }, loadOptions);

    marks.setMark('load');

    // the load binds the vsock socket, and the seal lands before guest code runs
    jails.removeUffdDevice(plan.paths.impId);
    jails.seal(plan.paths, pid);

    await api.resume();

    marks.setMark('resume');

    step.fault = 'agent';

    await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: options.parkedAgentMs ?? VM_DEADLINES.agentMs,
      attemptMs: 200,
      maxDelayMs: RESTORE_PING_DELAY_MS,
      isParked: true,
    });

    marks.setMark('parked');

    step.fault = null;

    const diskBytes = await plan.diskReady;

    if (plan.jail !== null) {
      jails.setupDiskOwner(plan.paths, plan.jail);
    }

    marks.setMark('disk');

    // virtio-blk tells the guest the disk's size through this config change,
    // and the parked agent waits for it before it touches the disk
    await api.patchDrive(VM_DEVICES.drives.rootfs, plan.diskPath);

    marks.setMark('patch');

    await sendClaim(plan.paths.vsockSocket, { ...plan.claim, diskBytes, unixMs: Date.now() });

    marks.setMark('claim');

    const ping = await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: CLAIMED_AGENT_DEADLINE_MS,
      maxDelayMs: RESTORE_PING_DELAY_MS,
      isParked: false,
    });

    marks.setMark('agent');

    const firecrackerVersion = await api.readVersion();

    marks.setMark('version');

    return {
      pid,
      hugePages: plan.hugePages,
      firecrackerVersion,
      agentVersion: ping.version,
      timings: marks.marks,
      guestSteps: Object.fromEntries(
        ping.bootSteps.map((bootStep) => [bootStep.name, bootStep.ms]),
      ),
      identityReset: ping.identityReset,
      bootId: ping.bootId,
    };
  } catch (error) {
    const reason = explainUffdFailure(plan.paths, '/proc', getErrorMessage(error));

    stopPid(pid);
    stopUffdHandler(plan.paths);

    await waitForExit(pid, plan.paths.apiSocket, VM_DEADLINES.killMs);

    await jails.release(plan.paths.impId);

    throw new TemplateRestoreError(
      `template restore failed: ${reason}\n${readLogTail(plan.paths.logFile, 5)}`,
      step.fault,
      error,
    );
  }
}
