import { expect, onTestFinished, test } from 'bun:test';
import { readBackupSecrets, readBackupStatus, wireBackupDrill } from '../lib/backup-drill';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  listCheckpoints,
  listImps,
  readState,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  const secrets = readBackupSecrets();

  return { prefix: getSuitePrefix('backups'), stack, client, secrets };
}

test('it backs up a running imp mid-write, a stopped imp and a checkpoint, adds next to nothing on the next run, and restores one imp or every imp of a point', async () => {
  const ctx = await setupTest();

  const drill = wireBackupDrill(ctx.stack, 'backupPointsSpansMs');
  const image = resolveImageName('e2e-tiny');
  const source = `${ctx.prefix}src`;
  const idle = `${ctx.prefix}idle`;
  const copy = `${ctx.prefix}copy`;

  await drill.resetState();
  await drill.startMinio(ctx.secrets);

  await runImp('new', source, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');
  await runImp('checkpoint', source, 'cp1');
  await writeGuestFile(source, '/root/f', 'v2');
  await runImp('new', idle, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, idle));

  await waitForExec(idle);
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);

  await runShellInImp(
    source,
    'echo \'i=0; while :; do echo "line $i" >> /root/log; i=$((i+1)); sleep 0.01; done\' > /root/writer.sh && setsid sh /root/writer.sh >/dev/null 2>&1 &',
  );

  const firstStarted = Date.now();

  const first = await drill.runBackup();

  writeMetric('backupFirstMs', Date.now() - firstStarted);
  writeMetric('backupFirstImpdMs', first.durationMs);
  writeMetric('backupFirstAddedMiB', Math.round(first.dataAddedBytes / 1_048_576));

  // The bracket keeps pkill from matching the shell that runs it.
  await runShellInImp(source, 'pkill -f "[w]riter.sh" || true');

  expect(first.imps).toContain(source);
  expect(first.imps).toContain(idle);
  expect(first.skipped).toStrictEqual([]);

  const nextStarted = Date.now();

  const next = await drill.runBackup();

  writeMetric('backupNextMs', Date.now() - nextStarted);
  writeMetric('backupNextAddedMiB', Math.round(next.dataAddedBytes / 1_048_576));

  expect(next.dataAddedBytes).toBeLessThan(first.dataAddedBytes / 4);

  const restoreStarted = Date.now();

  await runImp('backup', 'restore', source, '--as', copy);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, copy));
  writeMetric('backupRestoreMs', Date.now() - restoreStarted);

  const restoredState = await readState(copy);

  expect(restoredState).toBe('stopped');

  await runImp('start', copy);
  await waitForExec(copy);

  const restoredFile = await readGuestFile(copy, '/root/f');
  const last = await runShellInImp(copy, 'tail -n 1 /root/log');
  const checkpoints = await listCheckpoints(copy);

  expect(restoredFile).toBe('v2');
  expect(last).toMatch(/^line \d+$/v);
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['cp1']);

  await runImp('restore', copy, 'cp1');
  await waitForExec(copy);

  const checkpointFile = await readGuestFile(copy, '/root/f');

  expect(checkpointFile).toBe('v1');

  const all = await tryImp(['backup', 'restore', '--all']);
  const merged = await tryImp(['backup', 'restore', '--all', '--merge']);

  expect(all).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('restore --all --merge'),
  });

  expect(merged).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toSatisfy((stderr: string) =>
      new RegExp(`an imp named ${ctx.prefix}(?:src|idle) exists`, 'v').test(stderr),
    ),
  });

  // The newest point that holds the source: a scheduled run after the removal
  // below holds none of the journey's imps, and one after the copy's restore
  // holds the copy too.
  const status = await readBackupStatus();

  const point = status.points.findLast((candidate) => candidate.imps.includes(source));

  await runImp('rm', source);
  await runImp('rm', idle);
  await runImp('rm', copy);

  const others = await listImps();

  const result = await tryImp([
    'backup',
    'restore',
    '--all',
    '--at',
    point?.time.toISOString() ?? '',
  ]);

  const states = await Promise.all((point?.imps ?? []).map((name) => readState(name)));
  const restored = await listImps();

  expect(others).toStrictEqual([]);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: expect.toBeString(),
    stderr: expect.toInclude('stop the old impd'),
  });

  expect(point?.imps).toContain(idle);
  expect(restored.map((row) => row.name).toSorted()).toStrictEqual(point?.imps.toSorted() ?? []);
  expect(states).toSatisfyAll((state: string) => state === 'stopped');

  await runImp('start', source);
  await waitForExec(source);

  const sourceFile = await readGuestFile(source, '/root/f');

  expect(sourceFile).toBe('v2');
});

test('it restores a point that survived the scheduled forget and prune, and finds none before it', async () => {
  const ctx = await setupTest();

  const drill = wireBackupDrill(ctx.stack, 'backupPruneSpansMs');
  const idle = `${ctx.prefix}prune-idle`;
  const survivor = `${ctx.prefix}prune-kept`;

  // impd's scheduled run, and the prune after it, come every 5 s. Each fails
  // until MinIO answers, so the imp exists before it does: every point a
  // prune follows holds the imp.
  await drill.reboot({ IMP_BACKUP_INTERVAL_S: '5' });

  await runImp('new', idle, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, idle));

  await waitForExec(idle);
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);

  await drill.startMinio(ctx.secrets);
  await drill.runBackup();

  const before = await readBackupStatus();

  const firstTime = before.points[0]?.time ?? new Date();
  const pruneWaitStarted = Date.now();

  const status = await waitFor(
    'the scheduled prune',
    async () => {
      const current = await readBackupStatus();

      if (current.lastPruneAt === null || current.lastPruneAt < firstTime) {
        throw new Error(`no prune since the first point, last at ${String(current.lastPruneAt)}`);
      }

      return current;
    },
    { timeoutMs: 120_000 },
  );

  writeMetric('backupPruneWaitMs', Date.now() - pruneWaitStarted);
  writeMetric('backupPointsAfterPrune', status.points.length);

  await runImp('backup', 'restore', idle, '--as', survivor);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, survivor));

  const survivorState = await readState(survivor);

  const early = new Date(firstTime.getTime() - 1000).toISOString();

  const gone = await tryImp([
    'backup',
    'restore',
    idle,
    '--as',
    `${ctx.prefix}prune-early`,
    '--at',
    early,
  ]);

  // Every run so far fell in one hour, so forget keeps only the newest.
  expect(status.points.at(-1)?.imps).toContain(idle);
  expect(survivorState).toBe('stopped');
  expect(gone).toStrictEqual({ exitCode: 1, stdout: '', stderr: expect.toInclude('not found') });
});
