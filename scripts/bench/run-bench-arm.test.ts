import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBenchArm } from './run-bench-arm';
import type { ImpzRun } from './run-bench-arm';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'bench-arm-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { logPath: join(directory, 'candidate-1.impd.log') };
}

test('it saves the impd log and stops the dev instance after a bench that failed', async () => {
  const ctx = await setupTest();

  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const impzRuns: Readonly<Record<string, ImpzRun>> = {
    '--json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    create: { exitCode: 0, stdout: '', stderr: '' },
    wake: { exitCode: 1, stdout: '{"results":[]}\n', stderr: 'bench: wake at 4: no sample\n' },
  };

  const ran = await runBenchArm(
    {
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs: () => Promise.resolve(new TextEncoder().encode('impd stopped a wake\n')),
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: ctx.logPath,
    },
  );

  const log = await readFile(ctx.logPath, 'utf8');

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: false });
  expect(log).toBe('impd stopped a wake\n');
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it saves the impd log and stops the dev instance when the dev start fails', async () => {
  const ctx = await setupTest();

  const devRuns = {
    up: () => Promise.reject(new Error('imp-dev never got ready')),
    token: () => Promise.resolve('token-1\n'),
    down: () => Promise.resolve(''),
  };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') => devRuns[command]());

  const ran = runBenchArm(
    {
      runDev,
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () => Promise.resolve(new TextEncoder().encode('impd waited for its kernel\n')),
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: ctx.logPath,
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'imp-dev never got ready');

  const log = await readFile(ctx.logPath, 'utf8');

  expect(log).toBe('impd waited for its kernel\n');
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'down']);
});
