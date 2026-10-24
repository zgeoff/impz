import { expect, mock, onTestFinished, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import {
  buildBackupEnv,
  createBackupDrill,
  findPackKey,
  readBackupSecrets,
  readBackupSuiteSettings,
} from './backup-drill';
import { instance } from './instance';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const steps: string[] = [];

  const writeMetric = mock((key: string, value: unknown) => {
    steps.push(`metric ${key} ${JSON.stringify(value)}`);
  });

  return {
    stack,
    steps,
    writeMetric,
    deps: {
      suiteEnv: { IMP_BACKUP_INTERVAL_S: '3600', IMP_BACKUP_MEMORY_MIB: '256' },
      removeState: () => {
        steps.push('remove state');

        return Promise.resolve();
      },
      writeState: (state: Readonly<{ lastRunAt: Date }>) => {
        steps.push(`write state ${JSON.stringify(state)}`);

        return Promise.resolve();
      },
      reboot: (env: Readonly<Record<string, string>>) => {
        steps.push(`reboot onto ${JSON.stringify(env)}`);

        return Promise.resolve();
      },
      startMinio: () => {
        steps.push('start minio');

        return Promise.resolve();
      },
      stopMinio: () => {
        steps.push('stop minio');

        return Promise.resolve();
      },
      writeMetric,
    },
  };
}

test('#createBackupDrill writes each span of a backup test to its metric once the test’s cleanup ends', async () => {
  const ctx = setupTest();
  const clock = buildStubAnswerQueue([1000, 1600, 2000, 2100, 3000, 3500, 4000, 4700]);

  const drill = createBackupDrill(ctx.stack, 'backupTrialSpansMs', {
    ...ctx.deps,
    runBackup: () =>
      Promise.resolve({
        snapshotId: 'c0ffee12',
        imps: ['e2e-bk-src'],
        skipped: [],
        excluded: [],
        dataAddedBytes: 4096,
        durationMs: 480,
      }),
    now: clock.next,
  });

  await drill.reboot({ IMP_BACKUP_INTERVAL_S: '60' });

  await drill.startMinio({
    directory: '/repo/.cache/e2e/backups-b2',
    envFile: '/repo/.cache/e2e/backups-b2/restic.env',
    passwordInContainer: '/src/.cache/e2e/backups-b2/restic-password',
    accessKey: 'e2e-backups',
    secretKey: 'beef',
  });

  await drill.runBackup();
  await ctx.stack.disposeAsync();

  expect(ctx.writeMetric).toHaveBeenCalledExactlyOnceWith('backupTrialSpansMs', {
    rebootMs: 600,
    minioMs: 100,
    runsMs: 500,
    rebootBackMs: 700,
  });
});

test('#createBackupDrill clears the backup state before a reboot over the suite’s settings, and reboots back onto them before MinIO stops', async () => {
  const ctx = setupTest();

  const drill = createBackupDrill(ctx.stack, 'backupTrialSpansMs', {
    ...ctx.deps,
    runBackup: () => Promise.reject(new Error('this test runs no backup')),
    now: () => 0,
  });

  await drill.reboot({ IMP_BACKUP_INTERVAL_S: '5' });

  await drill.startMinio({
    directory: '/repo/.cache/e2e/backups-c3',
    envFile: '/repo/.cache/e2e/backups-c3/restic.env',
    passwordInContainer: '/src/.cache/e2e/backups-c3/restic-password',
    accessKey: 'e2e-backups',
    secretKey: 'cafe',
  });

  await ctx.stack.disposeAsync();

  expect(ctx.steps).toStrictEqual([
    'remove state',
    'reboot onto {"IMP_BACKUP_INTERVAL_S":"5","IMP_BACKUP_MEMORY_MIB":"256"}',
    'start minio',
    'reboot onto {"IMP_BACKUP_INTERVAL_S":"3600","IMP_BACKUP_MEMORY_MIB":"256"}',
    'stop minio',
    'metric backupTrialSpansMs {"rebootMs":0,"minioMs":0,"runsMs":0,"rebootBackMs":0}',
  ]);
});

test('#createBackupDrill marks a run as just done for a test on the suite’s settings, and stops MinIO with no reboot', async () => {
  const ctx = setupTest();

  const drill = createBackupDrill(ctx.stack, 'backupTrialSpansMs', {
    ...ctx.deps,
    runBackup: () => Promise.reject(new Error('this test runs no backup')),
    now: () => Date.parse('2026-03-14T09:26:53.000Z'),
  });

  await drill.resetState();

  await drill.startMinio({
    directory: '/repo/.cache/e2e/backups-d4',
    envFile: '/repo/.cache/e2e/backups-d4/restic.env',
    passwordInContainer: '/src/.cache/e2e/backups-d4/restic-password',
    accessKey: 'e2e-backups',
    secretKey: 'feed',
  });

  await ctx.stack.disposeAsync();

  expect(ctx.steps).toStrictEqual([
    'write state {"lastRunAt":"2026-03-14T09:26:53.000Z"}',
    'start minio',
    'stop minio',
    'metric backupTrialSpansMs {"rebootMs":0,"minioMs":0,"runsMs":0,"rebootBackMs":0}',
  ]);
});

test('#createBackupDrill neither reboots back nor stops MinIO for a test that reached neither', async () => {
  const ctx = setupTest();

  createBackupDrill(ctx.stack, 'backupTrialSpansMs', {
    ...ctx.deps,
    runBackup: () => Promise.reject(new Error('this test runs no backup')),
    now: () => 0,
  });

  await ctx.stack.disposeAsync();

  expect(ctx.steps).toStrictEqual([
    'metric backupTrialSpansMs {"rebootMs":0,"minioMs":0,"runsMs":0,"rebootBackMs":0}',
  ]);
});

test('#buildBackupEnv points impd at the drill repository with its keys and schedule, on small disks', () => {
  expect(
    buildBackupEnv(
      {
        directory: '/repo/.cache/e2e/backups-a1',
        envFile: '/repo/.cache/e2e/backups-a1/restic.env',
        passwordInContainer: '/src/.cache/e2e/backups-a1/restic-password',
        accessKey: 'e2e-backups',
        secretKey: 'f00d',
      },
      60,
    ),
  ).toStrictEqual({
    IMP_BACKUP_REPOSITORY: 's3:http://127.0.0.1:9000/imp-e2e',
    IMP_BACKUP_PASSWORD_FILE: '/src/.cache/e2e/backups-a1/restic-password',
    IMP_BACKUP_INTERVAL_S: '60',
    IMP_BACKUP_MEMORY_MIB: '256',
    IMP_DEV_BACKUP_ENV_FILE: '/repo/.cache/e2e/backups-a1/restic.env',
    IMP_DEFAULT_DISK_GIB: '4',
  });
});

test('#readBackupSecrets keeps one set of keys for an instance from call to call', () => {
  const target = { ...instance, container: `imp-e2e-secrets-${String(process.pid)}` };
  const first = readBackupSecrets(target);

  onTestFinished(() => {
    rmSync(first.directory, { recursive: true, force: true });
  });

  expect(readBackupSecrets(target)).toStrictEqual(first);
  expect(first.directory).toEndWith(`/.cache/e2e/backups-${target.container}`);

  expect(first.passwordInContainer).toBe(
    `/src/.cache/e2e/backups-${target.container}/restic-password`,
  );

  expect(first.secretKey).toMatch(/^[0-9a-f]{36}$/v);
});

test('#readBackupSuiteSettings points impd at the drill repository with the instance’s keys, an hour apart', () => {
  const target = { ...instance, container: `imp-e2e-suite-${String(process.pid)}` };
  const settings = readBackupSuiteSettings(target);
  const secrets = readBackupSecrets(target);

  onTestFinished(() => {
    rmSync(secrets.directory, { recursive: true, force: true });
  });

  expect(settings).toStrictEqual(buildBackupEnv(secrets, 3600));
});

test('#findPackKey reads the first data pack of a listing', () => {
  const listing = [
    '<ListBucketResult><Name>imp-e2e</Name>',
    '<Contents><Key>data/3f/3f9a</Key></Contents>',
    '<Contents><Key>data/a0/a0b1</Key></Contents>',
    '</ListBucketResult>',
  ].join('');

  expect(findPackKey(listing)).toBe('data/3f/3f9a');
});

test('#findPackKey reads a listing without packs as none', () => {
  expect(findPackKey('<ListBucketResult><Name>imp-e2e</Name></ListBucketResult>')).toBeUndefined();
});
