import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

export async function writeBackupSecrets(): Promise<BackupSecrets> {
  const parent = join(REPO_ROOT, '.cache', 'e2e');

  await mkdir(parent, { recursive: true });

  const directory = await mkdtemp(join(parent, 'backups-'));

  const accessKey = 'e2e-backups';
  const secretKey = randomBytes(18).toString('hex');
  const envFile = join(directory, 'restic.env');
  const passwordFile = join(directory, 'restic-password');

  await writeFile(passwordFile, randomBytes(24).toString('hex'), { mode: 0o644 });
  await writeFile(envFile, `AWS_ACCESS_KEY_ID=${accessKey}\nAWS_SECRET_ACCESS_KEY=${secretKey}\n`);

  return {
    directory,
    envFile,
    passwordInContainer: `/src/${passwordFile.slice(REPO_ROOT.length + 1)}`,
    accessKey,
    secretKey,
  };
}

export function removeBackupSecrets(secrets: Readonly<BackupSecrets>): Promise<void> {
  return rm(secrets.directory, { recursive: true, force: true });
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
  readonly reboot: (env: Readonly<Record<string, string>>) => Promise<void>;
  readonly startMinio: (secrets: Readonly<BackupSecrets>) => Promise<void>;
  readonly runBackup: () => Promise<BackupRun>;
}

interface BackupDrillDeps {
  readonly removeState: () => Promise<void>;
  readonly reboot: (env: Readonly<Record<string, string>>) => Promise<void>;
  readonly startMinio: (secrets: Readonly<BackupSecrets>) => Promise<void>;
  readonly stopMinio: () => Promise<void>;
  readonly runBackup: () => Promise<BackupRun>;
  readonly writeMetric: (key: string, value: unknown) => void;
  readonly now: () => number;
}

export function wireBackupDrill(stack: AsyncDisposableStack, metric: string): BackupDrill {
  return createBackupDrill(stack, metric, {
    removeState: async () => {
      const removed = await runInContainer(['rm', '-f', BACKUP_STATE_FILE]);

      if (removed.exitCode !== 0) {
        throw new Error(`the backup state could not go: ${removed.stderr}`);
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

    await deps.reboot({});

    spans.rebootBackMs += deps.now() - back;
  });

  return {
    // impd sets up its repository at start, so each test reboots onto its own.
    // impd keeps its last prune time across reboots and prunes once a day, so
    // an earlier test's prune would hold off this one's.
    reboot: async (env) => {
      const rebootStarted = deps.now();

      await deps.removeState();

      reached.isRebooted = true;

      await deps.reboot(env);

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
