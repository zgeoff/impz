import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopSuiteGroup } from '@impz/e2e-harness/run-suite';
import { createStubBin } from '@impz/shared/test-utils/create-stub-bin';
import type { StubBin } from '@impz/shared/test-utils/create-stub-bin';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-branch-tests-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return {
    directoryPath: directory,
    runBranchTests: async (rig: StubBin, paths: readonly string[]) => {
      const subprocess = Bun.spawn(
        [process.execPath, join(import.meta.dir, 'run-branch-tests.ts'), ...paths],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${rig.bin}:${process.env['PATH'] ?? ''}`,
            TEST_WORKERS: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        },
      );

      // The runner's test children outlive a timed-out test, so the group stops before the
      // fixture goes.
      stack.defer(async () => {
        stopSuiteGroup(subprocess.pid, 'SIGTERM');

        await subprocess.exited;
      });

      const [stdout, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        subprocess.exited,
      ]);

      return { stdout, exitCode };
    },
  };
}

test('it runs a dashboard test from the dashboard package and hands every other path to rig related', async () => {
  const ctx = await setupTest();

  const rig = createStubBin(join(ctx.directoryPath, '.stub'), 'rig', '');

  await mkdir(join(ctx.directoryPath, 'packages/dashboard/src'), { recursive: true });

  await writeFile(
    join(ctx.directoryPath, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"echo dashboard"}}',
  );

  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.tsx'), '');
  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.test.tsx'), '');

  const result = await ctx.runBranchTests(rig, [
    'src/a.ts',
    'src/b.host.test.ts',
    'packages/dashboard/src/view.tsx',
  ]);

  // The synced related-tests runner owns its bun test flags, and its own tests pin them.
  expect({ ...result, rigCalls: await readFile(rig.calls, 'utf8') }).toStrictEqual({
    stdout: expect.stringMatching(/^dashboard (?:--\S+ )+\.\/src\/view\.test\.tsx\n$/u),
    exitCode: 0,
    rigCalls: 'rig related src/a.ts src/b.host.test.ts\n',
  });
});

test('it fails and still runs the dashboard tests when rig related fails', async () => {
  const ctx = await setupTest();

  const rig = createStubBin(join(ctx.directoryPath, '.stub'), 'rig', 'exit 1');

  await mkdir(join(ctx.directoryPath, 'packages/dashboard/src'), { recursive: true });

  await writeFile(
    join(ctx.directoryPath, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"echo dashboard"}}',
  );

  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.test.tsx'), '');

  const result = await ctx.runBranchTests(rig, [
    'src/a.test.ts',
    'packages/dashboard/src/view.test.tsx',
  ]);

  expect(result).toStrictEqual({
    stdout: expect.stringMatching(/^dashboard (?:--\S+ )+\.\/src\/view\.test\.tsx\n$/u),
    exitCode: 1,
  });
});

test('it fails when only the dashboard tests fail', async () => {
  const ctx = await setupTest();

  const rig = createStubBin(join(ctx.directoryPath, '.stub'), 'rig', '');

  await mkdir(join(ctx.directoryPath, 'packages/dashboard/src'), { recursive: true });

  await writeFile(
    join(ctx.directoryPath, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"exit 1"}}',
  );

  await writeFile(join(ctx.directoryPath, 'packages/dashboard/src/view.test.tsx'), '');

  const result = await ctx.runBranchTests(rig, ['packages/dashboard/src/view.test.tsx']);

  expect({ ...result, rigCalls: await readFile(rig.calls, 'utf8') }).toStrictEqual({
    stdout: '',
    exitCode: 1,
    rigCalls: 'rig related\n',
  });
});
