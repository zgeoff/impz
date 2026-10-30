import { expect, mock, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import type { CommandResult } from '@impz/e2e-harness/instance';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { runBenchArm } from './run-bench-arm';

test('it saves the impd log and stops the dev instance after a bench that failed', async () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh up': { exitCode: 0, stdout: '', stderr: '' },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    '/work/impz bench create': { exitCode: 0, stdout: '', stderr: '' },
    '/work/impz bench wake --label candidate --json': {
      exitCode: 1,
      stdout: '{"results":[]}\n',
      stderr: 'bench: wake at 4: no sample\n',
    },
    'docker logs imp-dev': { exitCode: 0, stdout: 'impd stopped a wake\n', stderr: '' },
    '/work/candidate/scripts/dev/dev.sh down': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'not found' }),
  );

  const writeLog = mock<(path: string, text: string) => void>(() => {});

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: false });

  expect(writeLog).toHaveBeenCalledExactlyOnceWith(
    '/work/out/candidate-1.impd.log',
    'impd stopped a wake\n',
  );

  expect(runCommand.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}',
    '/work/candidate/scripts/dev/dev.sh up',
    '/work/candidate/scripts/dev/dev.sh token',
    '/work/impz info --json',
    '/work/impz bench create',
    '/work/impz info --json',
    '/work/impz bench wake --label candidate --json',
    'docker logs imp-dev',
    '/work/candidate/scripts/dev/dev.sh down',
  ]);
});

test('it points every impz command at the dev instance, past a saved host that IMP_HOST names', async () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    '/work/impz bench wake --label candidate --json': {
      exitCode: 0,
      stdout: '{"results":[]}\n',
      stderr: '',
    },
  };

  const runCommand = mock<
    (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<CommandResult>
  >((argv) => Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }));

  await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: { IMP_HOST: 'build-box' },
      cwd: '/work',
    },
  );

  const impzEnvs = runCommand.mock.calls
    .filter((call) => call[0][0] === '/work/impz')
    .map((call) => call[1]);

  expect(impzEnvs).toStrictEqual([
    { IMP_HOST: '', IMP_URL: 'http://localhost:7070', IMP_TOKEN: 'token-1' },
    { IMP_HOST: '', IMP_URL: 'http://localhost:7070', IMP_TOKEN: 'token-1' },
    { IMP_HOST: '', IMP_URL: 'http://localhost:7070', IMP_TOKEN: 'token-1' },
    { IMP_HOST: '', IMP_URL: 'http://localhost:7070', IMP_TOKEN: 'token-1' },
  ]);
});

test('it saves the impd log and stops the dev instance when the dev start fails', () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/baseline/scripts/dev/dev.sh up': {
      exitCode: 1,
      stdout: '',
      stderr: 'imp-dev never got ready\n',
    },
    'docker logs imp-dev': { exitCode: 0, stdout: 'impd waited for its kernel\n', stderr: '' },
    '/work/baseline/scripts/dev/dev.sh down': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'not found' }),
  );

  const writeLog = mock<(path: string, text: string) => void>(() => {});
  const onStderr = mock<(text: string) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/baseline-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'bench arms: dev.sh up exited 1');
  expect(onStderr).toHaveBeenCalledWith('imp-dev never got ready\n');
  expect(writeLog).toHaveBeenCalledOnce();

  expect(runCommand.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}',
    '/work/baseline/scripts/dev/dev.sh up',
    'docker logs imp-dev',
    '/work/baseline/scripts/dev/dev.sh down',
  ]);
});

test('it runs no impz command when the dev token cannot be read, and saves the log and stops', () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/baseline/scripts/dev/dev.sh up': { exitCode: 0, stdout: '', stderr: '' },
    '/work/baseline/scripts/dev/dev.sh token': {
      exitCode: 1,
      stdout: '',
      stderr: 'imp-dev wrote no token\n',
    },
    'docker logs imp-dev': { exitCode: 0, stdout: 'impd started\n', stderr: '' },
    '/work/baseline/scripts/dev/dev.sh down': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'not found' }),
  );

  const writeLog = mock<(path: string, text: string) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/baseline-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'bench arms: dev.sh token exited 1');

  expect(writeLog).toHaveBeenCalledExactlyOnceWith(
    '/work/out/baseline-1.impd.log',
    'impd started\n',
  );

  expect(runCommand.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}',
    '/work/baseline/scripts/dev/dev.sh up',
    '/work/baseline/scripts/dev/dev.sh token',
    'docker logs imp-dev',
    '/work/baseline/scripts/dev/dev.sh down',
  ]);
});

test('it skips the timed bench after a failed warm-up, and still saves the log and stops', () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh up': { exitCode: 0, stdout: '', stderr: '' },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":0}}',
      stderr: '',
    },
    '/work/impz bench create': {
      exitCode: 1,
      stdout: '',
      stderr: 'bench: create at 1: no sample\n',
    },
    'docker logs imp-dev': { exitCode: 0, stdout: 'impd refused a boot\n', stderr: '' },
    '/work/candidate/scripts/dev/dev.sh down': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'not found' }),
  );

  const writeLog = mock<(path: string, text: string) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: the warm-up failed: bench: create at 1: no sample\n',
  );

  expect(runCommand.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}',
    '/work/candidate/scripts/dev/dev.sh up',
    '/work/candidate/scripts/dev/dev.sh token',
    '/work/impz info --json',
    '/work/impz bench create',
    'docker logs imp-dev',
    '/work/candidate/scripts/dev/dev.sh down',
  ]);

  expect(writeLog).toHaveBeenCalledOnce();
});

test('it gives up on an instance that stays unready past the deadline, and saves the log, stops and frees its lock', () => {
  const clock = buildStubAnswerQueue([0, 600_000]);

  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh up': { exitCode: 0, stdout: '', stderr: '' },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: could not reach http://localhost:7070\n',
    },
    'docker logs imp-dev': { exitCode: 0, stdout: 'impd waited for its pool\n', stderr: '' },
    '/work/candidate/scripts/dev/dev.sh down': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'not found' }),
  );

  const writeLog = mock<(path: string, text: string) => void>(() => {});
  const release = mock(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release }),
      runCommand,
      writeLog,
      now: () => clock.next(),
      sleep: () => setImmediate(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    "timed out after 600000 ms waiting for bench arms: impd's default image: impz info exited 1: impz: could not reach http://localhost:7070\n",
  );

  expect(writeLog).toHaveBeenCalledExactlyOnceWith(
    '/work/out/candidate-1.impd.log',
    'impd waited for its pool\n',
  );

  expect(runCommand).toHaveBeenLastCalledWith(['/work/candidate/scripts/dev/dev.sh', 'down'], {
    IMP_KERNEL: '/work/candidate/.cache/ci/vmlinux',
    IMP_SYSTEM_DRIVE: '/work/candidate/.cache/ci/imp-system.squashfs',
  });

  expect(release).toHaveBeenCalledAfter(runCommand);
});

test('it keeps a failed warm-up as the arm error when dev.sh down fails after it, and reports the down', () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":0}}',
      stderr: '',
    },
    '/work/impz bench create': {
      exitCode: 1,
      stdout: '',
      stderr: 'bench: create at 1: no sample\n',
    },
    '/work/candidate/scripts/dev/dev.sh down': {
      exitCode: 1,
      stdout: '',
      stderr: 'docker: the daemon is busy\n',
    },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }),
  );

  const onStderr = mock<(text: string) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: the warm-up failed: bench: create at 1: no sample\n',
  );

  expect(onStderr).toHaveBeenCalledWith(
    'bench arms: dev.sh down exited 1, so imp-dev may still run\n',
  );
});

test('it keeps a failed warm-up as the arm error when dev.sh down cannot start, and reports the down', () => {
  const runs: Readonly<Record<string, () => Promise<CommandResult>>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': () =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    '/work/candidate/scripts/dev/dev.sh token': () =>
      Promise.resolve({ exitCode: 0, stdout: 'token-1\n', stderr: '' }),
    '/work/impz info --json': () =>
      Promise.resolve({
        exitCode: 0,
        stdout: '{"defaults":{"memoryMib":256,"image":"base"}}',
        stderr: '',
      }),
    '/work/impz bench create': () =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: 'impz: impd has no image base\n' }),
    '/work/candidate/scripts/dev/dev.sh down': () =>
      Promise.reject(new Error('spawn /work/candidate/scripts/dev/dev.sh EACCES')),
  };

  const onStderr = mock<(text: string) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand: (argv) =>
        runs[argv.join(' ')]?.() ?? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: the warm-up failed: impz: impd has no image base\n',
  );

  expect(onStderr).toHaveBeenCalledWith(
    'bench arms: dev.sh down could not run (spawn /work/candidate/scripts/dev/dev.sh EACCES), so imp-dev may still run\n',
  );
});

test('it keeps the arm error when its lock cannot be released, and reports the lock', () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh up': { exitCode: 1, stdout: '', stderr: '' },
  };

  const onStderr = mock<(text: string) => void>(() => {});

  const ran = runBenchArm(
    {
      lockDev: () => ({
        release: () => {
          throw new Error('EACCES: permission denied, rm');
        },
      }),
      runCommand: (argv) =>
        Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }),
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'bench arms: dev.sh up exited 1');

  expect(onStderr).toHaveBeenCalledWith(
    'bench arms: could not release the lock on imp-dev: EACCES: permission denied, rm\n',
  );
});

test('it keeps the report of a bench that passed but fails its arm when dev.sh down fails after it', async () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    '/work/impz bench wake --label candidate --json': {
      exitCode: 0,
      stdout: '{"results":[]}\n',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh down': { exitCode: 1, stdout: '', stderr: '' },
  };

  const onStderr = mock<(text: string) => void>(() => {});

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand: (argv) =>
        Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }),
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: false });

  expect(onStderr).toHaveBeenCalledWith(
    'bench arms: dev.sh down exited 1, so imp-dev may still run\n',
  );
});

test('it starts the warm-up only once impd has its default image', async () => {
  const infos = buildStubAnswerQueue<CommandResult>([
    { exitCode: 0, stdout: '{"defaults":{"memoryMib":256,"image":null}}', stderr: '' },
    { exitCode: 0, stdout: '{}', stderr: '' },
    {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
  ]);

  const runs: Readonly<Record<string, () => CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    '/work/impz info --json': () => infos.next(),
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')]?.() ?? { exitCode: 0, stdout: '', stderr: '' }),
  );

  await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  const impzCalls = runCommand.mock.calls
    .map((call) => call[0].join(' '))
    .filter((line) => line.startsWith('/work/impz'));

  expect(impzCalls.slice(0, 4)).toStrictEqual([
    '/work/impz info --json',
    '/work/impz info --json',
    '/work/impz info --json',
    '/work/impz bench create',
  ]);
});

test('it keeps the finished report, fails the arm, stops the dev instance and frees its lock when the impd log cannot be written', async () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    '/work/impz bench wake --label candidate --json': {
      exitCode: 0,
      stdout: '{"results":[]}\n',
      stderr: '',
    },
    'docker logs imp-dev': { exitCode: 0, stdout: 'impd woke 4 imps\n', stderr: '' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }),
  );

  const release = mock(() => {});
  const onStderr = mock<(text: string) => void>(() => {});

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release }),
      runCommand,
      writeLog: () => {
        throw new Error('ENOSPC: no space left on device, write');
      },
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: false });

  expect(onStderr).toHaveBeenCalledWith(
    'bench arms: could not save the impd log to /work/out/candidate-1.impd.log: ENOSPC: no space left on device, write\n',
  );

  expect(runCommand.mock.calls.at(-1)?.[0].join(' ')).toBe(
    '/work/candidate/scripts/dev/dev.sh down',
  );

  expect(release).toHaveBeenCalledAfter(runCommand);
});

test('it reads the impd log through the container CLI the dev instance uses, and fails a failed read', async () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'podman ps -a --filter name=^imp-bench$ --format {{.State}}': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    '/work/candidate/scripts/dev/dev.sh token': { exitCode: 0, stdout: 'token-1\n', stderr: '' },
    '/work/impz info --json': {
      exitCode: 0,
      stdout:
        '{"defaults":{"memoryMib":256,"image":"base"},"host":{"kernel":"6.1.0","cpuModel":"EPYC","isNested":true,"hugePages":"off","hugePool":null,"bootTemplates":1}}',
      stderr: '',
    },
    '/work/impz bench wake --label candidate --json': {
      exitCode: 0,
      stdout: '{"results":[]}\n',
      stderr: '',
    },
    'podman logs imp-bench': { exitCode: 125, stdout: '', stderr: 'no such container\n' },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }),
  );

  const onStderr = mock<(text: string) => void>(() => {});

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: { IMP_DEV_CONTAINER_CLI: 'podman', IMP_DEV_NAME: 'imp-bench' },
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: false });

  expect(onStderr).toHaveBeenCalledWith(
    'bench arms: podman logs imp-bench exited 125, so /work/out/candidate-1.impd.log holds no impd log\n',
  );

  expect(runCommand.mock.calls.at(-1)?.[0].join(' ')).toBe(
    '/work/candidate/scripts/dev/dev.sh down',
  );
});

test('it refuses an arm while a dev instance of that name already runs, and frees its lock', () => {
  const runs: Readonly<Record<string, CommandResult>> = {
    'docker ps -a --filter name=^imp-bench$ --format {{.State}}': {
      exitCode: 0,
      stdout: 'running\n',
      stderr: '',
    },
  };

  const runCommand = mock((argv: readonly string[]) =>
    Promise.resolve(runs[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'not found' }),
  );

  const release = mock(() => {});
  const lockDev = mock<(name: string) => { release: () => void }>(() => ({ release }));

  const ran = runBenchArm(
    {
      lockDev,
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'baseline', checkout: '/work/baseline' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/baseline-1.impd.log',
      impz: '/work/impz',
      env: { IMP_DEV_NAME: 'imp-bench' },
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: imp-bench already runs, and dev.sh up would bench it as baseline; stop it first',
  );

  expect(lockDev).toHaveBeenCalledExactlyOnceWith('imp-bench');
  expect(runCommand).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledAfter(runCommand);
});

test('it refuses an arm whose dev instance another bench holds, and touches nothing', () => {
  const runCommand = mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  const ran = runBenchArm(
    {
      lockDev: () => {
        throw new Error('process 4242 holds the dev instance imp-bench');
      },
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: { IMP_DEV_NAME: 'imp-bench' },
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(Error, 'process 4242 holds the dev instance imp-bench');
  expect(runCommand).not.toHaveBeenCalled();
});

test('it refuses an arm when the container CLI cannot say whether the instance runs', () => {
  const runCommand = mock(() =>
    Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
    }),
  );

  const ran = runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand,
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).rejects.toThrowWithMessage(
    Error,
    'bench arms: docker ps imp-dev exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
  );

  expect(runCommand).toHaveBeenCalledOnce();
});

test('it starts the timed bench only once the warm-up left a boot template ready', async () => {
  const infos = buildStubAnswerQueue<CommandResult>([
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

  const runs: Readonly<Record<string, () => CommandResult>> = {
    'docker ps -a --filter name=^imp-dev$ --format {{.State}}': () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    '/work/impz info --json': () => infos.next(),
    '/work/impz bench wake --label candidate --json': () => ({
      exitCode: 0,
      stdout: '{"results":[]}\n',
      stderr: '',
    }),
  };

  const ran = await runBenchArm(
    {
      lockDev: () => ({ release: () => {} }),
      runCommand: (argv) =>
        Promise.resolve(runs[argv.join(' ')]?.() ?? { exitCode: 0, stdout: '', stderr: '' }),
      writeLog: () => {},
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    {
      arm: { name: 'candidate', checkout: '/work/candidate' },
      commands: { warmUpArgs: ['bench', 'create'], benchArgs: ['wake'] },
      logPath: '/work/out/candidate-1.impd.log',
      impz: '/work/impz',
      env: {},
      cwd: '/work',
    },
  );

  expect(ran).toStrictEqual({ json: '{"results":[]}\n', isPassed: true });
  expect(infos.left).toBe(0);
});
