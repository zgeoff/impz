import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { startStubFirecrackerProcess } from '../../../testing/vm/start-stub-firecracker-process';
import { stopPid } from '../../platform/process/proc';
import {
  buildFirecrackerCommand,
  buildSpawnArgv,
  isImpVm,
  listFirecrackers,
  probeJailedFirecracker,
  probeProcessAlive,
  readLogTail,
  readPidFile,
  readVmOwner,
  startFirecracker,
  waitForExit,
} from './firecracker-process';
import { buildJailerCommand } from './jail';
import { readProcessCgroup } from './process-owner';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-fc-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('#listFirecrackers finds a live firecracker with the socket it serves and its owner', async () => {
  const ctx = setupTest();
  const apiSocket = join(ctx.directoryPath, 'api.sock');

  const child = await startStubFirecrackerProcess(apiSocket);

  const found = listFirecrackers();

  expect(found).toContainEqual({
    pid: child.pid,
    apiSocket,
    owner: { uid: process.getuid?.() ?? 0, cgroup: readProcessCgroup(child.pid) },
  });
});

test('#probeProcessAlive finds a live firecracker serving its socket in the host /proc by default', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.directoryPath, 'api.sock'));

  expect(probeProcessAlive(child.pid, join(ctx.directoryPath, 'api.sock'))).toBeTrue();
});

test('#probeProcessAlive finds a running firecracker serving its socket', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    'firecracker\0--api-sock\0/run/api.sock\0',
  );

  expect(probeProcessAlive(42, '/run/api.sock', join(ctx.directoryPath, 'proc'))).toBeTrue();
});

test('#probeProcessAlive finds no firecracker serving another socket under the pid', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    'firecracker\0--api-sock\0/run/other.sock\0',
  );

  expect(probeProcessAlive(42, '/run/api.sock', join(ctx.directoryPath, 'proc'))).toBeFalse();
});

test.each([
  ['a zombie', 'Z'],
  ['dead', 'X'],
])('#probeProcessAlive finds no firecracker that is %s', (_label, state) => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'stat'),
    `42 (firecracker) ${state} 1 42 42 0 -1`,
  );

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    'firecracker\0--api-sock\0/run/api.sock\0',
  );

  expect(probeProcessAlive(42, '/run/api.sock', join(ctx.directoryPath, 'proc'))).toBeFalse();
});

test('#probeProcessAlive reads the state past a command name with spaces and parentheses', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'proc', '42', 'stat'), '42 (fc (Z) x) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    'firecracker\0--api-sock\0/run/api.sock\0',
  );

  expect(probeProcessAlive(42, '/run/api.sock', join(ctx.directoryPath, 'proc'))).toBeTrue();
});

test('#probeProcessAlive finds no firecracker once its pid is gone', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'proc'));

  expect(probeProcessAlive(42, '/run/api.sock', join(ctx.directoryPath, 'proc'))).toBeFalse();
});

test('#waitForExit resolves true once the firecracker is gone', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.directoryPath, 'api.sock'));

  child.kill('SIGKILL');

  const exited = await waitForExit(child.pid, join(ctx.directoryPath, 'api.sock'), 4000);

  expect(exited).toBeTrue();
});

test('#waitForExit resolves false at the timeout while the firecracker still runs', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.directoryPath, 'api.sock'));
  const exited = await waitForExit(child.pid, join(ctx.directoryPath, 'api.sock'), 20);

  expect(exited).toBeFalse();
});

test('#readPidFile reads a missing pid file as none', () => {
  const ctx = setupTest();

  expect(readPidFile(join(ctx.directoryPath, 'pid'))).toBeNull();
});

test.each([
  ['4242\n', 4242],
  ['half', null],
  ['0', null],
  ['-3', null],
])('#readPidFile reads a pid file of %j as %p', (content, expected) => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'pid'), content);

  expect(readPidFile(join(ctx.directoryPath, 'pid'))).toBe(expected);
});

test('#readLogTail reads the last lines of the log', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'log'), 'one\ntwo\nthree\n');

  expect(readLogTail(join(ctx.directoryPath, 'log'), 2)).toBe('two\nthree');
});

test('#readLogTail reads a missing log as none', () => {
  const ctx = setupTest();

  expect(readLogTail(join(ctx.directoryPath, 'log'))).toBe('(no log)');
});

test('#buildSpawnArgv detaches the command', () => {
  expect(buildSpawnArgv(['firecracker', '--api-sock', 'api.sock'], null, null)).toStrictEqual([
    'setsid',
    'firecracker',
    '--api-sock',
    'api.sock',
  ]);
});

test('#buildSpawnArgv puts the merge wrapper before a plain firecracker', () => {
  expect(
    buildSpawnArgv(
      buildFirecrackerCommand('/usr/local/bin/firecracker', 'api.sock'),
      null,
      'ksm-exec',
    ),
  ).toStrictEqual(['setsid', 'ksm-exec', '/usr/local/bin/firecracker', '--api-sock', 'api.sock']);
});

test('#buildSpawnArgv puts the merge wrapper before the jailer, so the chroot needs no copy of it', () => {
  const jailer = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: '/var/lib/imp/jail',
    impId: 'imp',
    user: { uid: 900_000, gid: 900_000 },
    apiSocket: 'api.sock',
  });

  expect(buildSpawnArgv(jailer, null, 'ksm-exec')).toStrictEqual(['setsid', 'ksm-exec', ...jailer]);
});

// /usr/bin/env stands in for ksm-exec, because it too execs the rest of its argv
test('#buildSpawnArgv records the pid in the cgroup and execs the wrapper and the command', () => {
  const ctx = setupTest();
  const procs = join(ctx.directoryPath, 'cgroup.procs');

  const result = Bun.spawnSync(
    buildSpawnArgv(['echo', '--api-sock', 'api.sock'], procs, '/usr/bin/env'),
  );

  expect(result.stdout.toString()).toBe('--api-sock api.sock\n');
  expect(readFileSync(procs, 'utf8').trim()).toBe(String(result.pid));
});

test('#buildFirecrackerCommand names the API socket', () => {
  expect(buildFirecrackerCommand('/usr/local/bin/firecracker', '/i1/api.sock')).toStrictEqual([
    '/usr/local/bin/firecracker',
    '--api-sock',
    '/i1/api.sock',
  ]);
});

test('#startFirecracker resolves with the pid and writes it to the pid file once the socket opens', async () => {
  const ctx = setupTest();
  const apiSocket = join(ctx.directoryPath, 'api.sock');

  const pid = await startFirecracker(['sh', '-c', 'touch "$0"; exec sleep 30', apiSocket], {
    apiSocket,
    vsockSocket: join(ctx.directoryPath, 'vsock.sock'),
    logFile: join(ctx.directoryPath, 'log'),
    pidFile: join(ctx.directoryPath, 'pid'),
  });

  onTestFinished(() => {
    stopPid(pid);
  });

  expect(readPidFile(join(ctx.directoryPath, 'pid'))).toBe(pid);
});

test('#startFirecracker rejects with the log tail when the process exits before its socket opens', () => {
  const ctx = setupTest();

  expect(
    startFirecracker(['sh', '-c', 'echo no kvm >&2; exit 1'], {
      apiSocket: join(ctx.directoryPath, 'api.sock'),
      vsockSocket: join(ctx.directoryPath, 'vsock.sock'),
      logFile: join(ctx.directoryPath, 'log'),
      pidFile: join(ctx.directoryPath, 'pid'),
    }),
  ).rejects.toThrowWithMessage(Error, 'firecracker did not open its API socket (exit 1): no kvm');
});

test('#readVmOwner reads the uid and the cgroup of a process', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.directoryPath, 'api.sock'));

  expect(readVmOwner(child.pid)).toStrictEqual({
    uid: process.getuid?.() ?? 0,
    cgroup: readProcessCgroup(child.pid),
  });
});

test('#isImpVm takes a VM that runs as impd, unjailed', () => {
  expect(isImpVm({ uid: process.getuid?.() ?? 0, cgroup: '/other' }, 'i1', null)).toBeTrue();
});

test('#isImpVm takes a VM that runs as the imp jail uid', () => {
  expect(isImpVm({ uid: 900_001, cgroup: '/other' }, 'i1', 900_001)).toBeTrue();
});

test('#isImpVm takes a VM in the imp cgroup', () => {
  expect(isImpVm({ uid: 900_002, cgroup: '/imps/i1' }, 'i1', null)).toBeTrue();
});

test('#isImpVm refuses a VM of another uid in another cgroup', () => {
  expect(isImpVm({ uid: 900_002, cgroup: '/imps/i2' }, 'i1', 900_001)).toBeFalse();
});

test('#probeJailedFirecracker finds a process run with --id', async () => {
  // bash execs a lone last command in place; `; true` stops that, so the argv
  // keeps --id
  const child = Bun.spawn(['bash', '-c', 'sleep 30; true', 'x', '--id', 'i1']);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(readFileSync(`/proc/${String(child.pid)}/cmdline`, 'utf8').split('\0')).toContain(
      '--id',
    );
  });

  expect(probeJailedFirecracker(child.pid)).toBeTrue();
});

test('#probeJailedFirecracker finds an unjailed firecracker not jailed', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.directoryPath, 'api.sock'));

  expect(probeJailedFirecracker(child.pid)).toBeFalse();
});

test('#probeJailedFirecracker reads the command line from the /proc it is given', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    'firecracker\0--id\0i1\0--api-sock\0/run/api.sock\0',
  );

  expect(probeJailedFirecracker(42, join(ctx.directoryPath, 'proc'))).toBeTrue();
});

test('#listFirecrackers finds each firecracker in the /proc it is given, with its owner', () => {
  const ctx = setupTest();
  const procRoot = join(ctx.directoryPath, 'proc');

  mkdirSync(join(procRoot, '42'), { recursive: true });
  mkdirSync(join(procRoot, '43'));
  mkdirSync(join(procRoot, 'self'));
  writeFileSync(join(procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(procRoot, '42', 'cmdline'),
    '/usr/bin/firecracker\0--id\0i1\0--api-sock\0/run/api.sock\0',
  );

  writeFileSync(join(procRoot, '42', 'status'), 'Name:\tfirecracker\nUid:\t900001\t900001\t0\t0\n');
  writeFileSync(join(procRoot, '42', 'cgroup'), '0::/imps/i1\n');
  writeFileSync(join(procRoot, '43', 'stat'), '43 (sleep) S 1 43 43 0 -1');
  writeFileSync(join(procRoot, '43', 'cmdline'), 'sleep\0--api-sock\0/run/api.sock\0');

  expect(listFirecrackers(procRoot)).toStrictEqual([
    { pid: 42, apiSocket: '/run/api.sock', owner: { uid: 900_001, cgroup: '/imps/i1' } },
  ]);
});

test('#waitForExit gives up at the timeout of the injected clock while the firecracker stays', async () => {
  const ctx = setupTest();
  const clock = buildStubClock();

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    'firecracker\0--api-sock\0/run/api.sock\0',
  );

  const exited = await waitForExit(42, '/run/api.sock', 30, {
    clock,
    procRoot: join(ctx.directoryPath, 'proc'),
  });

  expect(exited).toBeFalse();
  expect(clock.sleeps).toStrictEqual([10, 10, 10, 10]);
});

test('#waitForExit resolves true at once for a pid gone from the /proc it is given', async () => {
  const ctx = setupTest();
  const clock = buildStubClock();

  mkdirSync(join(ctx.directoryPath, 'proc'));

  const exited = await waitForExit(42, '/run/api.sock', 30, {
    clock,
    procRoot: join(ctx.directoryPath, 'proc'),
  });

  expect(exited).toBeTrue();
  expect(clock.sleeps).toStrictEqual([]);
});
