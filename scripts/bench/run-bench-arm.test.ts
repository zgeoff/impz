import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { updateEnv } from '@impz/test-utils/update-env';
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
      probeDevRunning: () => Promise.resolve(false),
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs: () =>
        Promise.resolve({ exitCode: 0, output: new TextEncoder().encode('impd stopped a wake\n') }),
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
      probeDevRunning: () => Promise.resolve(false),
      runDev,
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () =>
        Promise.resolve({
          exitCode: 0,
          output: new TextEncoder().encode('impd waited for its kernel\n'),
        }),
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

test('it skips the timed bench after a failed warm-up, and still saves the log and stops', async () => {
  const ctx = await setupTest();

  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const impzRuns: Readonly<Record<string, ImpzRun>> = {
    '--json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":0}}',
      stderr: '',
    },
    create: { exitCode: 1, stdout: '', stderr: 'bench: create at 1: no sample\n' },
    wake: { exitCode: 0, stdout: '{"results":[]}\n', stderr: '' },
  };

  const runImpz = mock((args: readonly string[]) =>
    Promise.resolve(
      impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const ran = runBenchArm(
    {
      probeDevRunning: () => Promise.resolve(false),
      runDev,
      runImpz,
      readImpdLogs: () =>
        Promise.resolve({ exitCode: 0, output: new TextEncoder().encode('impd refused a boot\n') }),
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: ctx.logPath,
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: the warm-up failed: bench: create at 1: no sample\n',
  );

  const log = await readFile(ctx.logPath, 'utf8');

  expect(runImpz.mock.calls.map((call) => call[0][1])).toStrictEqual(['--json', 'create']);
  expect(log).toBe('impd refused a boot\n');
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it stops the dev instance when the impd log cannot be written', async () => {
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
    wake: { exitCode: 0, stdout: '{"results":[]}\n', stderr: '' },
  };

  const ran = runBenchArm(
    {
      probeDevRunning: () => Promise.resolve(false),
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs: () =>
        Promise.resolve({ exitCode: 0, output: new TextEncoder().encode('impd woke 4 imps\n') }),
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: join(ctx.logPath, 'missing-dir', 'candidate-1.impd.log'),
    },
  );

  expect(ran).rejects.toMatchObject({ code: 'ENOENT' });
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it reads the impd log through the container CLI the dev instance uses, and fails a failed read', async () => {
  const ctx = await setupTest();

  updateEnv('IMP_DEV_CONTAINER_CLI', 'podman');
  updateEnv('IMP_DEV_NAME', 'imp-bench');

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
    wake: { exitCode: 0, stdout: '{"results":[]}\n', stderr: '' },
  };

  const readImpdLogs = mock(() =>
    Promise.resolve({ exitCode: 125, output: new TextEncoder().encode('no such container\n') }),
  );

  const ran = runBenchArm(
    {
      probeDevRunning: () => Promise.resolve(false),
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: ctx.logPath,
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    `bench arms: podman logs imp-bench exited 125, so ${ctx.logPath} holds no impd log`,
  );

  expect(readImpdLogs).toHaveBeenCalledExactlyOnceWith('podman', 'imp-bench');
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it refuses an arm while a dev instance of that name already runs, and leaves it up', async () => {
  const ctx = await setupTest();

  updateEnv('IMP_DEV_NAME', 'imp-bench');

  const runDev = mock(() => Promise.resolve(''));

  const ran = runBenchArm(
    {
      probeDevRunning: () => Promise.resolve(true),
      runDev,
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () => Promise.resolve({ exitCode: 0, output: new Uint8Array() }),
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: ctx.logPath,
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: imp-bench already runs, and dev.sh up would bench it as baseline; stop it first',
  );

  expect(runDev).not.toHaveBeenCalled();
});

test('it starts the timed bench only once the warm-up left a boot template ready', async () => {
  const ctx = await setupTest();

  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const infos = buildStubAnswerQueue<ImpzRun>([
    {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":0}}',
      stderr: '',
    },
    {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":0}}',
      stderr: '',
    },
    {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
  ]);

  const impzRuns: Readonly<Record<string, () => ImpzRun>> = {
    '--json': () => infos.next(),
    create: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    wake: () => ({ exitCode: 0, stdout: '{"results":[]}\n', stderr: '' }),
  };

  const ran = await runBenchArm(
    {
      probeDevRunning: () => Promise.resolve(false),
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          (impzRuns[args[1] ?? ''] ?? (() => ({ exitCode: 127, stdout: '', stderr: '' })))(),
        ),
      readImpdLogs: () =>
        Promise.resolve({
          exitCode: 0,
          output: new TextEncoder().encode('impd built a template\n'),
        }),
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: ctx.logPath,
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: true });
  expect(infos.left).toBe(0);
});
