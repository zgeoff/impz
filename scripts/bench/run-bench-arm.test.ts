import { expect, mock, test } from 'bun:test';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { runBenchArm } from './run-bench-arm';
import type { CommandRun } from './run-bench-arm';

test('it saves the impd log and stops the dev instance after a bench that failed', async () => {
  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const impzRuns: Readonly<Record<string, CommandRun>> = {
    '--json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    create: { exitCode: 0, stdout: '', stderr: '' },
    wake: { exitCode: 1, stdout: '{"results":[]}\n', stderr: 'bench: wake at 4: no sample\n' },
  };

  const writeLog = mock<(path: string, output: Uint8Array) => void>(() => {});

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      inspectDev: () =>
        Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Error: No such object: imp-dev\n' }),
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs: () =>
        Promise.resolve({ exitCode: 0, output: new TextEncoder().encode('impd stopped a wake\n') }),
      writeLog,
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: false });

  expect(writeLog).toHaveBeenCalledExactlyOnceWith(
    '/work/out/candidate-1.impd.log',
    new TextEncoder().encode('impd stopped a wake\n'),
  );

  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it saves the impd log and stops the dev instance when the dev start fails', () => {
  const devRuns = {
    up: () => Promise.reject(new Error('imp-dev never got ready')),
    token: () => Promise.resolve('token-1\n'),
    down: () => Promise.resolve(''),
  };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') => devRuns[command]());
  const writeLog = mock<(path: string, output: Uint8Array) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      inspectDev: () =>
        Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Error: No such object: imp-dev\n' }),
      runDev,
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () =>
        Promise.resolve({
          exitCode: 0,
          output: new TextEncoder().encode('impd waited for its kernel\n'),
        }),
      writeLog,
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/baseline-1.impd.log',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'imp-dev never got ready');
  expect(writeLog).toHaveBeenCalledOnce();
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'down']);
});

test('it skips the timed bench after a failed warm-up, and still saves the log and stops', () => {
  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const impzRuns: Readonly<Record<string, CommandRun>> = {
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

  const writeLog = mock<(path: string, output: Uint8Array) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      inspectDev: () =>
        Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Error: No such object: imp-dev\n' }),
      runDev,
      runImpz,
      readImpdLogs: () =>
        Promise.resolve({ exitCode: 0, output: new TextEncoder().encode('impd refused a boot\n') }),
      writeLog,
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: the warm-up failed: bench: create at 1: no sample\n',
  );

  expect(runImpz.mock.calls.map((call) => call[0][1])).toStrictEqual(['--json', 'create']);
  expect(writeLog).toHaveBeenCalledOnce();
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it stops the dev instance and frees its lock when the impd log cannot be written', () => {
  const devOutput = { up: '', token: 'token-1\n', down: '' };
  const steps: string[] = [];

  const impzRuns: Readonly<Record<string, CommandRun>> = {
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
      lockDev: () => ({
        release: () => {
          steps.push('release');
        },
      }),
      inspectDev: () =>
        Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Error: No such object: imp-dev\n' }),
      runDev: (_script, command) => {
        steps.push(command);

        return Promise.resolve(devOutput[command]);
      },
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs: () =>
        Promise.resolve({ exitCode: 0, output: new TextEncoder().encode('impd woke 4 imps\n') }),
      writeLog: () => {
        throw new Error('ENOSPC: no space left on device, write');
      },
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'ENOSPC: no space left on device, write');
  expect(steps).toStrictEqual(['up', 'token', 'down', 'release']);
});

test('it reads the impd log through the container CLI the dev instance uses, and fails a failed read', () => {
  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const impzRuns: Readonly<Record<string, CommandRun>> = {
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
      lockDev: () => ({ release: () => {} }),
      inspectDev: () =>
        Promise.resolve({
          exitCode: 125,
          stdout: '',
          stderr: 'Error: no such container imp-bench\n',
        }),
      runDev,
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args[1] ?? ''] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      readImpdLogs,
      writeLog: () => {},
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: { IMP_DEV_CONTAINER_CLI: 'podman', IMP_DEV_NAME: 'imp-bench' },
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: podman logs imp-bench exited 125, so /work/out/candidate-1.impd.log holds no impd log',
  );

  expect(readImpdLogs).toHaveBeenCalledExactlyOnceWith('podman', 'imp-bench');
  expect(runDev.mock.calls.map((call) => call[1])).toStrictEqual(['up', 'token', 'down']);
});

test('it refuses an arm while a dev instance of that name already runs, and frees its lock', () => {
  const steps: string[] = [];

  const ran = runBenchArm(
    {
      lockDev: (name) => {
        steps.push(`lock ${name}`);

        return {
          release: () => {
            steps.push('release');
          },
        };
      },
      inspectDev: (_cli, name) => {
        steps.push(`inspect ${name}`);

        return Promise.resolve({ exitCode: 0, stdout: 'true\n', stderr: '' });
      },
      runDev: (_script, command) => {
        steps.push(command);

        return Promise.resolve('');
      },
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () => Promise.resolve({ exitCode: 0, output: new Uint8Array() }),
      writeLog: () => {},
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/baseline-1.impd.log',
      env: { IMP_DEV_NAME: 'imp-bench' },
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: imp-bench already runs, and dev.sh up would bench it as baseline; stop it first',
  );

  expect(steps).toStrictEqual(['lock imp-bench', 'inspect imp-bench', 'release']);
});

test('it refuses an arm whose dev instance another bench holds, and touches nothing', () => {
  const inspectDev = mock(() => Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }));
  const runDev = mock(() => Promise.resolve(''));

  const ran = runBenchArm(
    {
      lockDev: () => {
        throw new Error('process 4242 holds the dev instance imp-bench');
      },
      inspectDev,
      runDev,
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () => Promise.resolve({ exitCode: 0, output: new Uint8Array() }),
      writeLog: () => {},
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: { IMP_DEV_NAME: 'imp-bench' },
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'process 4242 holds the dev instance imp-bench');
  expect(inspectDev).not.toHaveBeenCalled();
  expect(runDev).not.toHaveBeenCalled();
});

test('it refuses an arm when the container CLI cannot say whether the instance runs', () => {
  const runDev = mock(() => Promise.resolve(''));

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      inspectDev: () =>
        Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
        }),
      runDev,
      runImpz: () => Promise.reject(new Error('no impz call was expected')),
      readImpdLogs: () => Promise.resolve({ exitCode: 0, output: new Uint8Array() }),
      writeLog: () => {},
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: docker inspect imp-dev exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
  );

  expect(runDev).not.toHaveBeenCalled();
});

test('it starts the timed bench only once the warm-up left a boot template ready', async () => {
  const devOutput = { up: '', token: 'token-1\n', down: '' };

  const runDev = mock((_script: string, command: 'up' | 'token' | 'down') =>
    Promise.resolve(devOutput[command]),
  );

  const infos = buildStubAnswerQueue<CommandRun>([
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

  const impzRuns: Readonly<Record<string, () => CommandRun>> = {
    '--json': () => infos.next(),
    create: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    wake: () => ({ exitCode: 0, stdout: '{"results":[]}\n', stderr: '' }),
  };

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      inspectDev: () =>
        Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Error: No such object: imp-dev\n' }),
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
      writeLog: () => {},
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: true });
  expect(infos.left).toBe(0);
});
