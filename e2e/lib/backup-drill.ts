import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { runImp } from './imp-cli';
import {
  REPO_ROOT,
  instance,
  runChecked,
  runCommand,
  runDevScript,
  runInContainer,
} from './instance';
import type { DevInstance } from './instance';
import { waitFor } from './wait-for';
import { writeMetric } from './write-metric';

const MINIO_IMAGE =
  'cgr.dev/chainguard/minio@sha256:0f95aa412a12351a95bb43c3b54b66440eb0aa022bb3f3458942678a489e915b';

const BUCKET = 'imp-e2e';
const BACKUP_REPOSITORY = `s3:http://127.0.0.1:9000/${BUCKET}`;

export interface BackupSecrets {
  // Under the repo, which the dev container mounts at /src.
  readonly directory: string;
  readonly envFile: string;
  readonly passwordInContainer: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export function buildBackupEnv(
  secrets: Readonly<BackupSecrets>,
  intervalS: number,
): Readonly<Record<string, string>> {
  return {
    IMP_BACKUP_REPOSITORY: BACKUP_REPOSITORY,
    IMP_BACKUP_PASSWORD_FILE: secrets.passwordInContainer,
    IMP_BACKUP_INTERVAL_S: String(intervalS),
    IMP_BACKUP_MEMORY_MIB: '256',
    IMP_DEV_BACKUP_ENV_FILE: secrets.envFile,

    // restic reads a disk's whole size, holes and all, on every run, so a drill's imps take the
    // smallest disk an image allows (4 GiB) in place of the 32 GiB default
    IMP_DEFAULT_DISK_GIB: '4',
  };
}

export function findPackKey(listing: string): string | undefined {
  return /<Key>(?<key>data\/[^<]+)<\/Key>/v.exec(listing)?.groups?.['key'];
}

const SkipSchema = z.object({ name: z.string(), reason: z.string() });

const BackupRunSchema = z.object({
  snapshotId: z.string(),
  imps: z.array(z.string()),
  skipped: z.array(SkipSchema),
  excluded: z.array(SkipSchema),
  dataAddedBytes: z.number(),
  durationMs: z.number(),
});

const PointSchema = z.object({ id: z.string(), time: z.coerce.date(), imps: z.array(z.string()) });
const CheckSchema = z.object({ at: z.coerce.date(), error: z.string().optional() });

const BackupStatusSchema = z.object({
  points: z.array(PointSchema),
  lastPruneAt: z.coerce.date().nullable(),
  lastCheck: CheckSchema.nullable(),
});

// One set per dev instance, kept across runs: impd reads the keys at its start, so the backups
// suites' settings hold them, and each test starts MinIO afresh with the same keys.
export function readBackupSecrets(target: Readonly<DevInstance> = instance): BackupSecrets {
  const directory = join(REPO_ROOT, '.cache', 'e2e', `backups-${target.container}`);
  const envFile = join(directory, 'restic.env');
  const passwordFile = join(directory, 'restic-password');
  const accessKey = 'e2e-backups';

  // The env file goes last, so a set it holds is whole.
  if (!existsSync(envFile)) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(passwordFile, randomBytes(24).toString('hex'), { mode: 0o644 });

    writeFileSync(
      envFile,
      `AWS_ACCESS_KEY_ID=${accessKey}\nAWS_SECRET_ACCESS_KEY=${randomBytes(18).toString('hex')}\n`,
    );
  }

  const secretKey = /^AWS_SECRET_ACCESS_KEY=(?<key>.+)$/mv.exec(readFileSync(envFile, 'utf8'))
    ?.groups?.['key'];

  if (secretKey === undefined) {
    throw new Error(`${envFile} holds no AWS_SECRET_ACCESS_KEY`);
  }

  return {
    directory,
    envFile,
    passwordInContainer: `/src/${passwordFile.slice(REPO_ROOT.length + 1)}`,
    accessKey,
    secretKey,
  };
}

// The backups suites' settings: impd backs up to the drill repository from the suite's reboot on.
// An hour's interval keeps scheduled runs out of the tests, which run their own.
export function readBackupSuiteSettings(
  target: Readonly<DevInstance> = instance,
): Readonly<Record<string, string>> {
  return buildBackupEnv(readBackupSecrets(target), 3600);
}

function readMinioName(): string {
  return `${instance.container}-minio`;
}

async function startMinio(secrets: Readonly<BackupSecrets>): Promise<void> {
  await runCommand(['docker', 'rm', '-f', readMinioName()]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    readMinioName(),
    '--network',
    `container:${instance.container}`,
    '--tmpfs',
    '/data:size=2g,uid=65532',
    '-e',
    `MINIO_ROOT_USER=${secrets.accessKey}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${secrets.secretKey}`,
    MINIO_IMAGE,
    'server',
    '/data',
    '--address',
    '127.0.0.1:9000',
  ]);

  await waitFor('MinIO to answer', async () => {
    const result = await runInContainer([
      'curl',
      '-sf',
      'http://127.0.0.1:9000/minio/health/ready',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

  const made = await runS3(secrets, 'PUT', '');

  if (made.exitCode !== 0) {
    throw new Error(`the bucket: ${made.stdout}${made.stderr}`);
  }
}

async function stopMinio(): Promise<void> {
  await runCommand(['docker', 'rm', '-f', readMinioName()]);
}

export function runS3(
  secrets: Readonly<BackupSecrets>,
  method: string,
  path: string,
  ...curlArgs: readonly string[]
) {
  return runInContainer([
    'curl',
    '-sS',
    '--fail-with-body',
    '-X',
    method,
    '--aws-sigv4',
    'aws:amz:us-east-1:s3',
    '--user',
    `${secrets.accessKey}:${secrets.secretKey}`,
    ...curlArgs,
    `http://127.0.0.1:9000/${BUCKET}${path}`,
  ]);
}

function buildResticExecArgs(
  secrets: Readonly<BackupSecrets>,
  args: readonly string[],
): readonly string[] {
  return [
    '--env-file',
    secrets.envFile,
    '-e',
    `RESTIC_REPOSITORY=${BACKUP_REPOSITORY}`,
    '-e',
    `RESTIC_PASSWORD_FILE=${secrets.passwordInContainer}`,
    instance.container,
    'restic',
    ...args,
  ];
}

export function runRestic(secrets: Readonly<BackupSecrets>, ...args: readonly string[]) {
  return runCommand(['docker', 'exec', ...buildResticExecArgs(secrets, args)]);
}

export function startRestic(secrets: Readonly<BackupSecrets>, ...args: readonly string[]) {
  return runCommand(['docker', 'exec', '-d', ...buildResticExecArgs(secrets, args)]);
}

async function runBackup() {
  const stdout = await runImp('backup', 'run', '--json');

  return BackupRunSchema.parse(JSON.parse(stdout));
}

const BACKUP_STATE_FILE = '/var/lib/imp/backup/state.json';

type BackupRun = z.infer<typeof BackupRunSchema>;

export interface BackupDrill {
  readonly resetState: () => Promise<void>;
  readonly reboot: (overrides: Readonly<Record<string, string>>) => Promise<void>;
  readonly startMinio: (secrets: Readonly<BackupSecrets>) => Promise<void>;
  readonly runBackup: () => Promise<BackupRun>;
}

interface BackupDrillDeps {
  // The suite's settings, which the instance runs on until a test reboots over them.
  readonly suiteEnv: Readonly<Record<string, string>>;

  readonly removeState: () => Promise<void>;
  readonly writeState: (state: Readonly<{ lastRunAt: Date }>) => Promise<void>;
  readonly reboot: (env: Readonly<Record<string, string>>) => Promise<void>;
  readonly startMinio: (secrets: Readonly<BackupSecrets>) => Promise<void>;
  readonly stopMinio: () => Promise<void>;
  readonly runBackup: () => Promise<BackupRun>;
  readonly writeMetric: (key: string, value: unknown) => void;
  readonly now: () => number;
}

export function wireBackupDrill(stack: AsyncDisposableStack, metric: string): BackupDrill {
  return createBackupDrill(stack, metric, {
    suiteEnv: readBackupSuiteSettings(),
    removeState: async () => {
      const removed = await runInContainer(['rm', '-f', BACKUP_STATE_FILE]);

      if (removed.exitCode !== 0) {
        throw new Error(`the backup state could not go: ${removed.stderr}`);
      }
    },
    writeState: async (state) => {
      const written = await runInContainer([
        'sh',
        '-c',
        'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
        'sh',
        BACKUP_STATE_FILE,
        JSON.stringify(state),
      ]);

      if (written.exitCode !== 0) {
        throw new Error(`the backup state could not be written: ${written.stderr}`);
      }
    },
    reboot: (env) => runDevScript('reboot', instance, env),
    startMinio,
    stopMinio,
    runBackup,
    writeMetric,
    now: Date.now,
  });
}

export function createBackupDrill(
  stack: AsyncDisposableStack,
  metric: string,
  deps: Readonly<BackupDrillDeps>,
): BackupDrill {
  const spans = { rebootMs: 0, minioMs: 0, runsMs: 0, rebootBackMs: 0 };
  const reached = { isRebooted: false, isMinioUp: false };

  stack.defer(() => {
    deps.writeMetric(metric, spans);
  });

  stack.defer(async () => {
    if (reached.isMinioUp) {
      await deps.stopMinio();
    }
  });

  // Before MinIO stops: impd's shutdown waits for a scheduled run, which
  // retries for seconds against a MinIO that is gone.
  stack.defer(async () => {
    if (!reached.isRebooted) {
      return;
    }

    const back = deps.now();

    await deps.reboot(deps.suiteEnv);

    spans.rebootBackMs += deps.now() - back;
  });

  return {
    // impd sets up the repository at each run, so a MinIO started afresh gives a test an empty
    // one with no reboot. A test on the suite's settings marks a run as just done, so no
    // scheduled run falls due, and drops an earlier test's prune and check.
    resetState: () => deps.writeState({ lastRunAt: new Date(deps.now()) }),

    // For a test that needs settings of its own. impd keeps its last prune time across reboots
    // and prunes once a day, so an earlier test's prune would hold off this one's.
    reboot: async (overrides) => {
      const rebootStarted = deps.now();

      await deps.removeState();

      reached.isRebooted = true;

      await deps.reboot({ ...deps.suiteEnv, ...overrides });

      spans.rebootMs += deps.now() - rebootStarted;
    },
    startMinio: async (secrets) => {
      const minioStarted = deps.now();

      reached.isMinioUp = true;

      await deps.startMinio(secrets);

      spans.minioMs += deps.now() - minioStarted;
    },
    runBackup: async () => {
      const started = deps.now();

      const run = await deps.runBackup();

      spans.runsMs += deps.now() - started;

      return run;
    },
  };
}

export async function readBackupStatus() {
  const stdout = await runImp('backup', 'ls', '--json');

  return BackupStatusSchema.parse(JSON.parse(stdout));
}
