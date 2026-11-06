import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  findPackKey,
  readBackupSecrets,
  readBackupStatus,
  runRestic,
  runS3,
  startRestic,
  wireBackupDrill,
} from '@impz/e2e-harness/backup-drill';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  createInstanceClient,
  readState,
  requireImp,
  runImp,
  runImpWith,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec, writeGuestFile } from '@impz/e2e-harness/imps';
import { runInContainer } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import {
  removeImpIfPresent,
  removeSecretIfPresent,
  removeTokenIfPresent,
} from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import * as z from 'zod';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  const secrets = readBackupSecrets();

  return { prefix: getSuitePrefix('backups-repo'), stack, client, secrets };
}

test('it lists no file of an imp created with backup off in the snapshot, and refuses its restore with why', async () => {
  const ctx = await setupTest();

  const drill = wireBackupDrill(ctx.stack, 'backupOffSpansMs');
  const kept = `${ctx.prefix}off-kept`;
  const chat = `${ctx.prefix}off-chat`;

  await drill.resetState();
  await drill.startMinio(ctx.secrets);

  await runImp('new', kept, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, kept));

  await runImp(
    'new',
    chat,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--no-backup',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, chat));

  await waitForExec(chat);
  await writeGuestFile(chat, '/root/transcript', 'transcript-in-plain-text');
  await runImp('checkpoint', chat, 'cp1');
  await runImp('stop', chat);

  const keptRow = await requireImp(kept);
  const chatRow = await requireImp(chat);
  const run = await drill.runBackup();
  const listing = await runRestic(ctx.secrets, 'ls', '--json', run.snapshotId);

  const paths = listing.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => z.object({ path: z.string().optional() }).parse(JSON.parse(line)).path ?? '')
    .filter((path) => path !== '');

  await runImp('rm', chat);

  const restore = await tryImp(['backup', 'restore', chat]);

  expect(chatRow.backup).toBe(false);
  expect(run.imps).toContain(kept);
  expect(run.excluded).toStrictEqual([{ name: chat, reason: 'created with backup off' }]);
  expect(paths).toSatisfyAny((path: string) => path.includes(keptRow.id));
  expect(paths).not.toSatisfyAny((path: string) => path.includes(chatRow.id));

  expect(restore).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude(
      `imp ${chat} is left out of backups (created with backup off): backup ${run.snapshotId}`,
    ),
  });
});

test('it restores past a stale lock in the repository, and fails the check loudly on a corrupted pack', async () => {
  const ctx = await setupTest();

  const drill = wireBackupDrill(ctx.stack, 'backupLockSpansMs');
  const idle = `${ctx.prefix}lock-idle`;
  const unlocked = `${ctx.prefix}lock-kept`;

  await drill.resetState();
  await drill.startMinio(ctx.secrets);

  await runImp('new', idle, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, idle));

  await waitForExec(idle);
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);

  await drill.runBackup();

  // `check` takes restic's exclusive lock and, throttled to 16 KiB/s, holds it
  // for minutes on this repository; a SIGKILL leaves it behind.
  await startRestic(ctx.secrets, '--limit-download', '16', 'check', '--read-data');

  await waitFor('restic check to take its lock', async () => {
    const held = await runRestic(ctx.secrets, 'list', 'locks', '--no-lock');

    if (held.stdout.trim() === '') {
      throw new Error('no lock yet');
    }
  });

  await runInContainer(['pkill', '-9', '-f', 'restic --limit-download']);

  const locks = await runRestic(ctx.secrets, 'list', 'locks', '--no-lock');

  const lockId = locks.stdout.trim().split('\n')[0] ?? '';

  const lock = await runRestic(ctx.secrets, 'cat', 'lock', lockId, '--no-lock');

  expect(lock.stdout).toContain('"exclusive": true');

  await runImp('backup', 'restore', idle, '--as', unlocked);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, unlocked));

  const unlockedState = await readState(unlocked);

  expect(unlockedState).toBe('stopped');

  const listing = await runS3(ctx.secrets, 'GET', '?list-type=2&prefix=data/');

  const key = findPackKey(listing.stdout) ?? '';

  const made = await runInContainer(['mktemp', '-d']);

  const packDir = made.stdout.trim();

  ctx.stack.defer(async () => {
    await runInContainer(['rm', '-rf', packDir]);
  });

  const saved = await runS3(ctx.secrets, 'GET', `/${key}`, '-o', `${packDir}/pack`);

  const put = await runS3(
    ctx.secrets,
    'PUT',
    `/${key}`,
    '--data-binary',
    randomBytes(4096).toString('hex'),
  );

  expect(key).not.toBe('');
  expect(saved.exitCode).toBe(0);
  expect(put.exitCode).toBe(0);

  const check = await tryImp(['backup', 'check', '--subset', '100%']);
  const status = await readBackupStatus();
  const restored = await runS3(ctx.secrets, 'PUT', `/${key}`, '--data-binary', `@${packDir}/pack`);

  expect(check).toStrictEqual({ exitCode: 1, stdout: '', stderr: expect.toStartWith('impz: ') });
  expect(status.lastCheck?.error).toBeString();
  expect(restored.exitCode).toBe(0);
});

test('it brings back a named token, its secret’s name and the grant from a backup with the database copy, after the host lost them', async () => {
  const ctx = await setupTest();

  const drill = wireBackupDrill(ctx.stack, 'backupDatabaseSpansMs');
  const name = `${ctx.prefix}db`;
  const secret = `${ctx.prefix}gh`;
  const token = `${ctx.prefix}agent`;

  await drill.reboot({ IMP_BACKUP_DATABASE: 'true' });
  await drill.startMinio(ctx.secrets);

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await runImpWith(
    { stdin: 'ghp_e2e_never_backed_up\n' },
    'secret',
    'add',
    secret,
    '--kind',
    'github',
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  const made = await runImp('token', 'new', token, '--scope', 'exec', '--imps', `${name}*`);

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, token));

  const tokenSecret = made.trim();

  const run = await drill.runBackup();
  const listing = await runRestic(ctx.secrets, 'ls', '--json', run.snapshotId);

  const paths = listing.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => z.object({ path: z.string().optional() }).parse(JSON.parse(line)).path ?? '')
    .filter((path) => path !== '');

  await runImp('rm', name);
  await runImp('token', 'rm', token);
  await runImp('secret', 'rm', secret);

  const lost = await tryImp(['ls'], { token: tokenSecret });
  const result = await tryImp(['backup', 'restore', '--all']);
  const listed = await tryImp(['ls', '--json'], { token: tokenSecret });
  const grants = await runImp('grants', name, '--json');
  const secrets = await runImp('secret', 'ls', '--json');

  expect(paths).toSatisfyAny((path: string) => path.endsWith('/database/impd.sqlite'));
  expect(lost.exitCode).not.toBe(0);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: expect.toBeString(),
    stderr: expect.toInclude(`impz: tokens restored: ${token}`),
  });

  expect(listed).toStrictEqual({ exitCode: 0, stdout: expect.toInclude(name), stderr: '' });
  expect(z.array(z.string()).parse(JSON.parse(grants))).toStrictEqual([secret]);
  expect(secrets).toInclude(secret);
});
