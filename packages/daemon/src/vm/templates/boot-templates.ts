import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { withContext } from '@logtape/logtape';
import { match } from 'ts-pattern';
import * as z from 'zod';
import type { SlotAddress } from '../../host-net/net/addressing';
import type { TapDevices } from '../../host-net/net/tap-devices';
import { buildBackoffMs } from '../../platform/process/build-backoff-ms';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { runCommand } from '../../platform/process/run-command';
import { createSemaphore } from '../../platform/process/semaphore';
import { createSingleFlight } from '../../platform/process/single-flight';
import type { RamAdmission } from '../imps-contract/ram-admission';
import type { HostIdentity } from '../sleep/vm-identity';
import type { DiskBudget } from '../storage/disk-budget';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import type { HugePages } from '../vmm/firecracker-client';
import type { JailUser } from '../vmm/jail';
import type { TemplateBuildPlan, TemplateFault } from '../vmm/template-vm';
import { TEMPLATE_BOOT_ARGS, buildTemplateKey } from './build-template-key';
import type { TemplateShape } from './build-template-key';
import { pickRestoreFailureOutcome } from './pick-restore-failure-outcome';
import { createTemplateLocks } from './template-locks';
import type { TemplateLockDeps } from './template-locks';

const TEMPLATE_ADDRESS: SlotAddress = {
  slot: -1,
  tap: 'imp-tpl',
  hostIp: '169.254.255.253',
  guestIp: '169.254.255.254',
  prefixLength: 30,
  netmask: '255.255.255.252',
  guestMac: '06:00:a9:fe:ff:fe',
  hostMac: '06:01:a9:fe:ff:fd',
  guestIp6: null,
  tailnetPort: 0,
};

const BUILD_JAIL_ID = 'tpl-build';
const BUILD_CPU = { limit: null, weight: 100 };
const PLACEHOLDER_BYTES = 1024 * 1024;
const PLACEHOLDER_NAME = 'placeholder.ext4';
const MIB = 1024 * 1024;
const MIN_MISSES = 2;
const MAX_TEMPLATES = 4;
const MAX_BUILD_FAILURES = 3;
const BUILD_RETRY_MS = 60_000;

const TemplateMetaSchema = z.object({
  buildId: z.string(),
  vcpus: z.int().positive(),
  memoryMib: z.int().positive(),
  hugePages: z.enum(['None', '2M']).default('None'),
  systemDrivePath: z.string(),
});

type TemplateMeta = z.infer<typeof TemplateMetaSchema>;

interface TemplateFiles {
  readonly key: string;
  readonly buildId: string;
  readonly vmstate: string;
  readonly memFile: string;
  readonly hugePages: HugePages;

  // A Firecracker restore reopens the system drive the snapshot booted and the placeholder it saw
  // as its disk.
  readonly systemDrivePath: string;
  readonly placeholderPath: string;
}

interface RestoreFailure {
  readonly fault: TemplateFault;
  readonly restoredBefore: number;
}

export interface BootTemplates {
  readonly requestTemplate: (shape: Readonly<TemplateShape>) => TemplateFiles | null;
  readonly buildTemplate: (shape: Readonly<TemplateShape>) => Promise<TemplateFiles>;

  // restoredBefore is the build's restore count when the failed restore began,
  // so an agent timeout beside a restore that succeeded reads as a busy host
  readonly reportFailure: (
    files: Readonly<TemplateFiles>,
    failure: Readonly<RestoreFailure>,
  ) => void;
  readonly reportRestored: (files: Readonly<TemplateFiles>) => void;
  readonly countRestored: (files: Readonly<TemplateFiles>) => number;
  readonly removeStale: () => string[];
  readonly listDrivePaths: () => string[];
  readonly lockKept: () => Promise<void>;
  readonly readLockedMib: () => number;
  readonly stop: () => Promise<void>;
}

export interface BootTemplateDeps {
  readonly dataDir: string;
  readonly identity: HostIdentity;
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly minGuestUptimeMs: number;
  readonly bootReservePercent: number;
  readonly ramBudgetMib: number;
  readonly buildVm: (plan: Readonly<TemplateBuildPlan>) => Promise<void>;
  readonly lockMemory: TemplateLockDeps['lockMemory'];
  readonly taps: TapDevices;
  readonly jail: JailUser | null;
  readonly cgroups: Pick<CpuCgroups, 'setup' | 'remove'>;
  readonly admission: RamAdmission;
  readonly diskBudget?: Pick<DiskBudget, 'withRoom'> | undefined;
  readonly now?: () => number;
}

class BuildRefusedError extends Error {
  override name = 'BuildRefusedError';
}

interface KeyRecord {
  misses: number;
  buildFailures: number;
  restoreFailures: number;
  retryAt: number;
  isOff: boolean;
}

export function createBootTemplates(deps: BootTemplateDeps): BootTemplates {
  const root = join(deps.dataDir, 'templates');
  const now = deps.now ?? Date.now;

  // A Firecracker snapshot records its drive paths, so every template shares this one.
  const placeholder = join(root, PLACEHOLDER_NAME);
  const building = createSingleFlight<TemplateFiles>();

  const records = new Map<string, KeyRecord>();
  const lastUsed = new Map<string, number>();
  const restoredByBuild = new Map<string, number>();

  const lane = createSemaphore(1);

  const getRecord = (key: string): KeyRecord => {
    const found = records.get(key);

    if (found !== undefined) {
      return found;
    }

    const record = { misses: 0, buildFailures: 0, restoreFailures: 0, retryAt: 0, isOff: false };

    records.set(key, record);

    return record;
  };

  const readMeta = (key: string): TemplateMeta | null => {
    try {
      const text = readFileSync(join(root, key, 'meta.json'), 'utf8');

      return TemplateMetaSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  };

  const readReady = (key: string): TemplateFiles | null => {
    const directory = join(root, key);
    const meta = readMeta(key);
    const files = { vmstate: join(directory, 'vmstate'), memFile: join(directory, 'mem') };

    if (meta === null || !existsSync(files.vmstate) || !existsSync(files.memFile)) {
      return null;
    }

    return {
      key,
      buildId: meta.buildId,
      ...files,
      hugePages: meta.hugePages,
      systemDrivePath: meta.systemDrivePath,
      placeholderPath: placeholder,
    };
  };

  const listTemplateKeys = (): string[] =>
    existsSync(root)
      ? readdirSync(root).filter((name) => name !== PLACEHOLDER_NAME && !name.startsWith('.'))
      : [];

  // Linux keeps a mapped mem file alive until its last VM exits, so a directory that a restore may
  // still map is renamed away before it is removed.
  const removeDir = (name: string): void => {
    templateLocks.release(name);

    const gone = join(root, `.gone-${Bun.randomUUIDv7()}`);

    try {
      renameSync(join(root, name), gone);
    } catch {
      return;
    }

    rmSync(gone, { recursive: true, force: true });

    lastUsed.delete(name);
  };

  const templateLocks = createTemplateLocks({
    lockMemory: deps.lockMemory,
    probeCurrent: (target) => readMeta(target.key)?.buildId === target.buildId,
    ramBudgetMib: deps.ramBudgetMib,
    logger: getImpdLogger('boot'),
  });

  const readLastUsed = (key: string): number => {
    const used = lastUsed.get(key);

    if (used !== undefined) {
      return used;
    }

    try {
      return statSync(join(root, key)).mtimeMs;
    } catch {
      return 0;
    }
  };

  const removeLeastUsed = (keep: string): void => {
    const keys = listTemplateKeys().filter((key) => key !== keep);
    const excess = keys.length + 1 - MAX_TEMPLATES;

    if (excess <= 0) {
      return;
    }

    const byAge = keys.toSorted((left, right) => readLastUsed(left) - readLastUsed(right));

    for (const key of byAge.slice(0, excess)) {
      removeDir(key);

      getImpdLogger('boot').info('removed boot template {key}: least recently used', {
        key: key.slice(0, 12),
      });
    }
  };

  const writeTemplate = async (
    shape: Readonly<TemplateShape>,
    key: string,
    work: string,
    buildId: string,
  ): Promise<TemplateFiles> => {
    const runDir = join(work, 'run');

    mkdirSync(runDir, { recursive: true });

    if (!existsSync(placeholder)) {
      writeFileSync(placeholder, '');
      truncateSync(placeholder, PLACEHOLDER_BYTES);
    }

    const started = performance.now();

    await deps.taps.setupTap(TEMPLATE_ADDRESS, deps.jail);

    const snapshotDir = join(work, 'snapshot');
    const cgroup = deps.cgroups.setup(BUILD_JAIL_ID, BUILD_CPU, shape.memoryMib);

    if (cgroup === null && deps.jail !== null) {
      throw new Error('a jailed template build needs its own cgroup, and it has none');
    }

    try {
      await deps.buildVm({
        firecrackerBin: deps.firecrackerBin,
        kernelPath: deps.kernelPath,
        systemDrivePath: deps.identity.systemDrivePath,
        bootArgs: TEMPLATE_BOOT_ARGS,
        vcpus: shape.vcpus,
        memoryMib: shape.memoryMib,
        hugePages: shape.hugePages ?? 'None',
        workDir: work,
        paths: {
          runDir,
          apiSocket: join(runDir, 'api.sock'),
          vsockSocket: join(runDir, 'vsock.sock'),
          logFile: join(runDir, 'firecracker.log'),
          pidFile: join(runDir, 'pid'),
        },
        placeholderPath: placeholder,
        tap: TEMPLATE_ADDRESS.tap,
        guestMac: TEMPLATE_ADDRESS.guestMac,
        jailId: BUILD_JAIL_ID,
        jail: deps.jail,
        cgroup,
        minGuestUptimeMs: deps.minGuestUptimeMs,
        snapshotDir,
        vmstate: join(snapshotDir, 'vmstate'),
        memFile: join(snapshotDir, 'mem'),
      });
    } finally {
      // A throw from finally would replace the build's own error, so this one is only logged.
      await deps.cgroups.remove(BUILD_JAIL_ID).catch((error: unknown) => {
        getImpdLogger('cgroup').warning('cgroup {id}: {error}', {
          id: BUILD_JAIL_ID,
          error: getErrorMessage(error),
        });
      });
    }

    // Digging holes in the mem file is safe only before any VM maps it.
    await runCommand(['fallocate', '--dig-holes', join(snapshotDir, 'mem')]);

    const meta: TemplateMeta = {
      buildId,
      vcpus: shape.vcpus,
      memoryMib: shape.memoryMib,
      hugePages: shape.hugePages ?? 'None',
      systemDrivePath: deps.identity.systemDrivePath,
    };

    writeFileSync(join(snapshotDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(snapshotDir, join(root, key));

    lastUsed.set(key, now());

    removeLeastUsed(key);

    const durationMs = Math.round(performance.now() - started);

    getImpdLogger('boot').info('boot template {key} built in {durationMs}ms', {
      key: key.slice(0, 12),
      durationMs: String(durationMs),
    });

    const files = {
      key,
      buildId,
      vmstate: join(root, key, 'vmstate'),
      memFile: join(root, key, 'mem'),
      hugePages: meta.hugePages,
      systemDrivePath: meta.systemDrivePath,
      placeholderPath: placeholder,
    };

    void templateLocks.lock(files);

    return files;
  };

  const runBuild = async (shape: Readonly<TemplateShape>, key: string): Promise<TemplateFiles> => {
    const work = join(root, `.build-${Bun.randomUUIDv7()}`);
    const id = `template-${key.slice(0, 12)}`;
    const buildId = Bun.randomUUIDv7();
    const progress = { isBuilding: false };

    const writeAdmitted = (): Promise<TemplateFiles> => {
      progress.isBuilding = true;

      return writeTemplate(shape, key, work, buildId);
    };

    try {
      await deps.admission.admit({
        id,
        name: null,
        reserveMib: Math.ceil((shape.memoryMib * deps.bootReservePercent) / 100),
        memoryMib: shape.memoryMib,
        hugePagesMib: shape.hugePages === '2M' ? shape.memoryMib : 0,
        maySleepImps: false,
        isBackground: true,
      });

      return await (deps.diskBudget === undefined
        ? writeAdmitted()
        : deps.diskBudget.withRoom(shape.memoryMib * MIB, writeAdmitted));
    } catch (error) {
      if (progress.isBuilding) {
        throw error;
      }

      throw new BuildRefusedError(getErrorMessage(error), { cause: error });
    } finally {
      deps.admission.release(id);

      rmSync(work, { recursive: true, force: true });
    }
  };

  const setBuildFailed = (key: string, error: unknown): void => {
    const record = getRecord(key);

    if (error instanceof BuildRefusedError) {
      record.retryAt = now() + BUILD_RETRY_MS;

      getImpdLogger('boot').warning(
        'boot template {key} build refused (next try in {retryS}s): {message}',
        { key: key.slice(0, 12), retryS: String(BUILD_RETRY_MS / 1000), message: error.message },
      );

      return;
    }

    record.buildFailures += 1;

    record.retryAt =
      now() +
      buildBackoffMs(record.buildFailures, {
        baseMs: BUILD_RETRY_MS,
        capMs: Number.POSITIVE_INFINITY,
      });

    record.isOff = record.buildFailures >= MAX_BUILD_FAILURES;

    const next = record.isOff
      ? 'off until impd restarts'
      : `next try in ${String(Math.round((record.retryAt - now()) / 1000))}s`;

    getImpdLogger('boot').warning('boot template {key} build failed ({next}): {error}', {
      key: key.slice(0, 12),
      next,
      error: getErrorMessage(error),
    });
  };

  const createTemplateFiles = (shape: Readonly<TemplateShape>): Promise<TemplateFiles> => {
    const key = buildTemplateKey(deps.identity, shape);
    const record = getRecord(key);

    if (record.isOff) {
      return Promise.reject(new Error('boot templates of this shape are off until impd restarts'));
    }

    const ready = readReady(key);

    if (ready !== null) {
      return Promise.resolve(ready);
    }

    const inFlight = building.findRun(key);

    if (inFlight !== undefined) {
      return inFlight;
    }

    if (now() < record.retryAt) {
      return Promise.reject(
        new Error('boot template builds of this shape back off; try again later'),
      );
    }

    return building.run(key, async () => {
      try {
        return await lane.run(() => runBuild(shape, key));
      } catch (error) {
        setBuildFailed(key, error);
        throw error;
      }
    });
  };

  const createInBackground = async (shape: Readonly<TemplateShape>): Promise<void> => {
    try {
      await createTemplateFiles(shape);
    } catch {
      // the build's failure is already logged
    }
  };

  return {
    requestTemplate: (shape) => {
      const key = buildTemplateKey(deps.identity, shape);
      const record = getRecord(key);

      if (record.isOff) {
        return null;
      }

      const ready = readReady(key);

      if (ready !== null) {
        lastUsed.set(key, now());

        return ready;
      }

      record.misses += 1;

      if (record.misses >= MIN_MISSES && now() >= record.retryAt) {
        // the build serves every imp of the shape, so its lines leave out the imp whose boot
        // started it, which LogTape's implicit context would otherwise add
        void withContext({ imp: undefined }, () => createInBackground(shape));
      }

      return null;
    },
    buildTemplate: createTemplateFiles,
    reportFailure: (files, failure) => {
      const record = getRecord(files.key);

      const outcome = pickRestoreFailureOutcome({
        fault: failure.fault,
        isCurrentBuild: readMeta(files.key)?.buildId === files.buildId,
        restoredBefore: failure.restoredBefore,
        restoredNow: restoredByBuild.get(files.buildId) ?? 0,
        failuresBefore: record.restoreFailures,
        isOff: record.isOff,
      });

      const removeFailed = (): void => {
        record.restoreFailures += 1;

        removeDir(files.key);
      };

      match(outcome)
        .with('ignore', () => {})
        .with('keep', () => {
          getImpdLogger('boot').info(
            'boot template {key} kept: its agent timed out while another restore of it succeeded',
            { key: files.key.slice(0, 12) },
          );
        })
        .with('remove', removeFailed)
        .with('disable', () => {
          removeFailed();

          record.isOff = true;

          getImpdLogger('boot').warning(
            'boot template {key} off until impd restarts: {restoreFailures} restores failed',
            { key: files.key.slice(0, 12), restoreFailures: String(record.restoreFailures) },
          );
        })
        .exhaustive();
    },
    reportRestored: (files) => {
      getRecord(files.key).restoreFailures = 0;

      restoredByBuild.set(files.buildId, (restoredByBuild.get(files.buildId) ?? 0) + 1);
    },
    countRestored: (files) => restoredByBuild.get(files.buildId) ?? 0,
    removeStale: () => {
      if (!existsSync(root)) {
        return [];
      }

      const live = new Set(building.listKeys());

      const probeCurrent = (name: string) => {
        const meta = readMeta(name);

        return meta !== null && buildTemplateKey(deps.identity, meta) === name;
      };

      const stale = readdirSync(root).filter(
        (name) =>
          name !== PLACEHOLDER_NAME &&
          !live.has(name) &&
          (name.startsWith('.') || !probeCurrent(name)),
      );

      for (const name of stale) {
        removeDir(name);
      }

      return stale.filter((name) => !name.startsWith('.'));
    },
    listDrivePaths: () =>
      listTemplateKeys().flatMap((key) => {
        const meta = readMeta(key);

        return meta === null ? [] : [meta.systemDrivePath];
      }),
    lockKept: async () => {
      for (const key of listTemplateKeys()) {
        const ready = readReady(key);

        if (ready !== null) {
          await templateLocks.lock(ready);
        }
      }
    },
    readLockedMib: templateLocks.readLockedMib,

    // the locks stop first, so a build that finishes during the wait starts no lock
    stop: async () => {
      await Promise.all([templateLocks.stop(), building.waitForAll()]);
    },
  };
}
