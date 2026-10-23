import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLocalEntries } from '@impz/local-tar';
import { captureImpdLogs } from '../../../../testing/platform/capture-impd-logs';
import { writeContextTar } from './write-context-tar';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-context-tar-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it writes the entries as a tar that holds each of them by name', async () => {
  const ctx = await setupTest();

  const context = join(ctx.directoryPath, 'context');

  mkdirSync(join(context, 'src'), { recursive: true });
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(context, 'src', 'a.txt'), 'a\n');

  const entries = await listLocalEntries(context);

  await writeContextTar(entries, join(ctx.directoryPath, 'context.tar'));

  const listed = Bun.spawnSync([
    'tar',
    '-tf',
    join(ctx.directoryPath, 'context.tar'),
  ]).stdout.toString();

  expect(listed.trim().split('\n')).toStrictEqual([
    'context/',
    'context/Dockerfile',
    'context/src/',
    'context/src/a.txt',
  ]);
});

test('it writes the content of each file into the tar', async () => {
  const ctx = await setupTest();

  const context = join(ctx.directoryPath, 'context');

  mkdirSync(context);
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\n');

  const entries = await listLocalEntries(context);

  await writeContextTar(entries, join(ctx.directoryPath, 'context.tar'));

  const read = Bun.spawnSync([
    'tar',
    '-xOf',
    join(ctx.directoryPath, 'context.tar'),
    'context/Dockerfile',
  ]);

  expect(read.stdout.toString()).toBe('FROM scratch\n');
});

test('it writes the tar readable by impd alone', async () => {
  const ctx = await setupTest();

  const context = join(ctx.directoryPath, 'context');

  mkdirSync(context);
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\n');

  const entries = await listLocalEntries(context);

  await writeContextTar(entries, join(ctx.directoryPath, 'context.tar'));

  expect(statSync(join(ctx.directoryPath, 'context.tar')).mode & 0o777).toBe(0o600);
});

test('it warns of an entry it leaves out of the tar', async () => {
  const ctx = await setupTest();

  const logs = captureImpdLogs();
  const context = join(ctx.directoryPath, 'context');

  mkdirSync(context);
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\n');

  Bun.spawnSync(['mkfifo', join(context, 'pipe')]);

  const entries = await listLocalEntries(context);

  await writeContextTar(entries, join(ctx.directoryPath, 'context.tar'));

  expect(logs).toStrictEqual([
    `WARNING impd.image image build context: ${context}/pipe: not a file, directory or symlink; left out`,
  ]);
});

test('it refuses a path that exists already', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'context.tar'), 'old');

  expect(writeContextTar([], join(ctx.directoryPath, 'context.tar'))).rejects.toMatchObject({
    code: 'EEXIST',
  });
});
