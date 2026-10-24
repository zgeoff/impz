import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-branch-tests-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it runs a dashboard test from the dashboard package and every other test from the root', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'src'));
  await mkdir(join(ctx.directoryPath, 'packages/dashboard/src'), { recursive: true });
  await writeFile(join(ctx.directoryPath, 'package.json'), '{"scripts":{"test":"echo root"}}');

  await writeFile(
    join(ctx.directoryPath, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"echo dashboard"}}',
  );

  await writeFile(join(ctx.directoryPath, 'src/a.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/a.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.tsx'), '');
  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.test.tsx'), '');

  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'src/a.ts',
      'packages/dashboard/src/view.tsx',
    ],
    { cwd: ctx.directoryPath, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'root ./src/a.test.ts\ndashboard ./src/view.test.tsx\n',
    exitCode: 0,
  });
});

test('it fails and still runs the dashboard tests when the root tests fail', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'src'));
  await mkdir(join(ctx.directoryPath, 'packages/dashboard/src'), { recursive: true });
  await writeFile(join(ctx.directoryPath, 'package.json'), '{"scripts":{"test":"exit 1"}}');

  await writeFile(
    join(ctx.directoryPath, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"echo dashboard"}}',
  );

  await writeFile(join(ctx.directoryPath, 'src/a.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.test.tsx'), '');

  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'src/a.test.ts',
      'packages/dashboard/src/view.test.tsx',
    ],
    { cwd: ctx.directoryPath, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'dashboard ./src/view.test.tsx\n',
    exitCode: 1,
  });
});

test('it fails when only the dashboard tests fail', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'packages/dashboard/src'), { recursive: true });
  await writeFile(join(ctx.directoryPath, 'package.json'), '{"scripts":{"test":"echo root"}}');

  await writeFile(
    join(ctx.directoryPath, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"exit 1"}}',
  );

  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.test.tsx'), '');

  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'packages/dashboard/src/view.test.tsx',
    ],
    { cwd: ctx.directoryPath, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'run-related-tests: no related tests\n',
    exitCode: 1,
  });
});

test('it leaves out a lane file, which runs only in its lane script', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'src'));
  await writeFile(join(ctx.directoryPath, 'package.json'), '{"scripts":{"test":"echo root"}}');
  await writeFile(join(ctx.directoryPath, 'src/a.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/a.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/a.host.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/b.headscale.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/c.pebble.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/d.docker.test.ts'), '');
  await writeFile(join(ctx.directoryPath, 'src/e.small-fs.test.ts'), '');

  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'src/a.ts',
      'src/a.host.test.ts',
      'src/b.headscale.test.ts',
      'src/c.pebble.test.ts',
      'src/d.docker.test.ts',
      'src/e.small-fs.test.ts',
    ],
    { cwd: ctx.directoryPath, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'root ./src/a.test.ts\nrun-related-tests: no related tests\n',
    exitCode: 0,
  });
});
