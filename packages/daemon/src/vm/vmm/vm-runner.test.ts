import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { FRAME_TYPES, PingSchema, encodeMessageFrame } from '@impz/agent-protocol';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildMockTemplateBuildPlan } from '../../../testing/vm/build-mock-template-build-plan';
import { buildMockTemplateRestorePlan } from '../../../testing/vm/build-mock-template-restore-plan';
import { buildStubJails } from '../../../testing/vm/build-stub-jails';
import { createStubKsmExec } from '../../../testing/vm/create-stub-ksm-exec';
import { createStubUffdHandler } from '../../../testing/vm/create-stub-uffd-handler';
import { makeRecordingFirecrackerClient } from '../../../testing/vm/make-recording-firecracker-client';
import { startStubAgent } from '../../../testing/vm/start-stub-agent';
import {
  buildStubFirecrackerArgv,
  startStubFirecracker,
} from '../../../testing/vm/start-stub-firecracker';
import { startStubParkedAgent } from '../../../testing/vm/start-stub-parked-agent';
import { deriveSlotAddress, parseSubnet } from '../../host-net/net/addressing';
import { stopPid } from '../../platform/process/proc';
import { sendPing } from '../agent-client/agent-requests';
import { buildImpPaths, buildSnapshotPaths } from '../storage/data-layout';
import { createFirecrackerClient } from './firecracker-client';
import { probeProcessAlive } from './firecracker-process';
import { buildJailerCommand } from './jail';
import { readHandlerState, startUffdHandler } from './uffd-handler';
import { createVmRunner } from './vm-runner';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-vm-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const createImpDir = (impId: string) => {
    const paths = buildImpPaths(directory, impId);

    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.disk, '');

    return paths;
  };

  return { directoryPath: directory, createImpDir, logPath: join(directory, 'calls.log') };
}

test('#sleepVm resumes a VM whose pause fails and leaves it running, its limit back', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm {"state":"Paused"}'],
    isLoggingBodies: true,
  });

  const limits: string[] = [];

  const cgroup = {
    procsPath: '/nonexistent',
    liftLimit: () => {
      limits.push('lifted');
    },
    applyLimit: () => {
      limits.push('applied');
    },
  };

  const sleeping = createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, cgroup, paths);

  expect(sleeping).rejects.toThrow('refused PATCH /vm');

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'GET /machine-config',
    'PATCH /vm {"state":"Paused"}',
    'PATCH /vm {"state":"Resumed"}',
  ]);

  expect(limits).toStrictEqual(['lifted', 'applied']);
  expect(probeProcessAlive(vm.pid, paths.apiSocket)).toBeTrue();
});

test('#sleepVm kills a VM whose pause and resume both fail', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm'],
  });

  expect(
    createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths),
  ).rejects.toThrow('refused PATCH /vm');

  expect(probeProcessAlive(vm.pid, paths.apiSocket)).toBeFalse();
});

test('#sleepVm writes only the pages a woken VM dirtied, over a copy of the memory file it woke from', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, `${'a'.repeat(4096)}${'b'.repeat(4096)}${'c'.repeat(4096)}`);

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: { pages: 'aBc', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  const timings = await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(readFileSync(paths.memFile, 'latin1')).toBe(
    `${'a'.repeat(4096)}${'B'.repeat(4096)}${'c'.repeat(4096)}`,
  );

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'GET /machine-config',
    'PATCH /vm {"state":"Paused"}',
    `PUT /snapshot/create {"snapshot_type":"Diff","snapshot_path":"${paths.vmstate}.new","mem_file_path":"${paths.memFile}.new","sync_snapshot_files":true}`,
  ]);

  expect(timings).toContainKey('copyBase');
});

test('#sleepVm writes a woken VM into another slot over a copy of the memory file it woke from', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const slot = buildSnapshotPaths(join(paths.directory, 'watchdog'));

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, `${'a'.repeat(4096)}${'b'.repeat(4096)}`);

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: { pages: 'aB', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, slot);

  expect(readFileSync(slot.memFile, 'latin1')).toBe(`${'a'.repeat(4096)}${'B'.repeat(4096)}`);

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'GET /machine-config',
    'PATCH /vm {"state":"Paused"}',
    `PUT /snapshot/create {"snapshot_type":"Diff","snapshot_path":"${slot.vmstate}.new","mem_file_path":"${slot.memFile}.new","sync_snapshot_files":true}`,
  ]);
});

test('#sleepVm takes a full snapshot of a VM that does not track its dirty pages, though a memory file is there to copy', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, `${'a'.repeat(4096)}${'b'.repeat(4096)}`);

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: { pages: 'aB', dirtyPages: [1], isTrackingDirtyPages: false },
  });

  const timings = await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'GET /machine-config',
    'PATCH /vm {"state":"Paused"}',
    `PUT /snapshot/create {"snapshot_type":"Full","snapshot_path":"${paths.vmstate}.new","mem_file_path":"${paths.memFile}.new","sync_snapshot_files":true}`,
  ]);

  expect(timings).not.toContainKey('copyBase');
});

test('#sleepVm takes a full snapshot of a VM that does not track its dirty pages', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: { pages: 'aB', dirtyPages: [], isTrackingDirtyPages: false },
  });

  await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(readFileSync(paths.memFile, 'latin1')).toBe(`${'a'.repeat(4096)}${'B'.repeat(4096)}`);

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'GET /machine-config',
    'PATCH /vm {"state":"Paused"}',
    `PUT /snapshot/create {"snapshot_type":"Full","snapshot_path":"${paths.vmstate}.new","mem_file_path":"${paths.memFile}.new","sync_snapshot_files":true}`,
  ]);
});

test('#sleepVm takes a full snapshot of a woken VM whose memory file cannot be copied', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: { pages: 'aB', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  const timings = await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(readFileSync(paths.memFile, 'latin1')).toBe(`${'a'.repeat(4096)}${'B'.repeat(4096)}`);
  expect(readFileSync(ctx.logPath, 'utf8')).toInclude('{"snapshot_type":"Full"');
  expect(timings).toContainKey('copyBaseFailed');
});

test('#sleepVm removes the memory file a woken VM woke from when its snapshot fails, and leaves the VM running', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, `${'a'.repeat(4096)}${'b'.repeat(4096)}`);

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    failures: ['PUT /snapshot/create'],
    memory: { pages: 'aB', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  const sleeping = createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(sleeping).rejects.toThrow('refused PUT /snapshot/create');
  expect(existsSync(paths.memFile)).toBeFalse();
  expect(existsSync(`${paths.memFile}.new`)).toBeFalse();
  expect(probeProcessAlive(vm.pid, paths.apiSocket)).toBeTrue();
});

test('#sleepVm removes the memory file a VM woke from when a full snapshot fails after its machine config did not answer', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, `${'a'.repeat(4096)}${'b'.repeat(4096)}`);

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    failures: ['GET /machine-config', 'PUT /snapshot/create'],
    memory: { pages: 'aB', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  const sleeping = createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(sleeping).rejects.toThrow('refused PUT /snapshot/create');
  expect(readFileSync(ctx.logPath, 'utf8')).toInclude('{"snapshot_type":"Full"');
  expect(existsSync(paths.memFile)).toBeFalse();
});

test('#readGuestUptimeMs asks the agent with a 250 ms deadline', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const ping = mock(() =>
    Promise.resolve(create(PingSchema, { ok: true, version: '0.1.0', uptimeMs: 1350 })),
  );

  const uptime = await createVmRunner(buildStubJails().jails, {
    sendUptimePing: ping,
  }).readGuestUptimeMs(paths);

  expect(uptime).toBe(1350);
  expect(ping).toHaveBeenCalledWith(paths.vsockSocket, 250);
});

test('#readGuestUptimeMs reads no uptime from an agent that does not answer by the deadline', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  await startStubAgent(paths.vsockSocket, () => {});

  const uptime = await createVmRunner(buildStubJails().jails, {
    sendUptimePing: (vsockPath) => sendPing(vsockPath, 20),
  }).readGuestUptimeMs(paths);

  expect(uptime).toBeNull();
});

test('#readGuestUptimeMs reads no uptime from an agent that cannot read its clock', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  await startStubAgent(paths.vsockSocket, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, PingSchema, { ok: true, version: '0.1.0' }),
    );
  });

  const uptime = await createVmRunner(buildStubJails().jails).readGuestUptimeMs(paths);

  expect(uptime).toBeNull();
});

test('#startVm returns the steps the guest reports for its boot', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const argv = buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const starting = createVmRunner(buildStubJails({ argv }).jails).startVm({
    firecrackerBin: 'firecracker',
    kernelPath: '/data/system/vmlinux',
    systemDrivePath: '/data/system/drives/system.squashfs',
    paths,
    address: deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 }),
    impId: 'vm',
    hostname: 'dev',
    vcpus: 1,
    memoryMib: 256,
    maxMemoryMib: 256,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: { uid: 900_000, gid: 900_000 },
  });

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  onTestFinished(() => {
    stopPid(pid);
  });

  await startStubAgent(paths.vsockSocket, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, PingSchema, {
        ok: true,
        version: '0.1.0',
        bootSteps: [
          // oxlint-disable zgeoff/no-abbreviated-names -- `ms` is BootStep's field in proto/
          { name: 'world', ms: 9 },
          { name: 'mount', ms: 35 },
          { name: 'ready', ms: 1 },
          // oxlint-enable zgeoff/no-abbreviated-names
        ],
      }),
    );
  });

  const vm = await starting;

  expect(vm.guestSteps).toStrictEqual({ world: 9, mount: 35, ready: 1 });
});

test('#startVm fails a boot whose Firecracker API refuses every call, and leaves no rejection unhandled', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const argv = buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath });
  const unhandled: unknown[] = [];

  const recordUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  process.on('unhandledRejection', recordUnhandled);

  onTestFinished(() => {
    process.off('unhandledRejection', recordUnhandled);
  });

  const version = Promise.withResolvers<string>();

  const runner = createVmRunner(buildStubJails({ argv }).jails, {
    createClient: (_, timeouts) => ({
      ...createFirecrackerClient(join(ctx.directoryPath, 'refused.sock'), timeouts),
      readVersion: () => version.promise,
    }),
  });

  const starting = runner.startVm({
    firecrackerBin: 'firecracker',
    kernelPath: '/data/system/vmlinux',
    systemDrivePath: '/data/system/drives/system.squashfs',
    paths,
    address: deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 }),
    impId: 'vm',
    hostname: 'dev',
    vcpus: 1,
    memoryMib: 256,
    maxMemoryMib: 256,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: { uid: 900_000, gid: 900_000 },
  });

  const failure = await starting.then(
    () => null,
    (error: unknown) => error,
  );

  version.reject(new Error('connect ECONNREFUSED'));

  // Bun reports an unhandled rejection once the microtask queue drains,
  // so one macrotask turn after the reject is enough to see it
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  expect(failure).toBeInstanceOf(Error);
  expect(unhandled).toStrictEqual([]);
});

test('#readVmState reads the VM state from the API', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const state = await createVmRunner(buildStubJails().jails).readVmState(paths);

  expect(state).toBe('Running');
});

test('#readVmState asks Firecracker through the client the runner is given', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const sockets: string[] = [];

  await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const runner = createVmRunner(buildStubJails().jails, {
    createClient: (socketPath, timeouts) => {
      sockets.push(socketPath);

      return createFirecrackerClient(socketPath, timeouts);
    },
  });

  const state = await runner.readVmState(paths);

  expect(state).toBe('Running');
  expect(sockets).toStrictEqual([paths.apiSocket]);
});

test('#createTemplateVm builds a template through the client the runner is given', async () => {
  const ctx = setupTest();
  const calls: string[] = [];

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: plan.paths.apiSocket, logPath: ctx.logPath }),
  });

  const runner = createVmRunner(stub.jails, {
    createClient: makeRecordingFirecrackerClient(calls),
  });

  const building = runner.createTemplateVm(plan);

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  expect(calls).toIncludeAllMembers([
    `${plan.paths.apiSocket} putMachineConfig`,
    `${plan.paths.apiSocket} instanceStart`,
    `${plan.paths.apiSocket} createSnapshot`,
  ]);
});

test('#loadTemplateVm restores a template through the client the runner is given', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('i1');
  const calls: string[] = [];

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath }),
  });

  const runner = createVmRunner(stub.jails, {
    createClient: makeRecordingFirecrackerClient(calls),
  });

  const restoring = runner.loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
  );

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  onTestFinished(() => {
    stopPid(pid);
  });

  await startStubParkedAgent(paths.vsockSocket);
  await restoring;

  expect(calls).toStrictEqual([
    `${paths.apiSocket} loadSnapshot`,
    `${paths.apiSocket} resume`,
    `${paths.apiSocket} patchDrive`,
    `${paths.apiSocket} readVersion`,
  ]);
});

test('#listVms lists the firecrackers in the /proc the runner is given', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const procRoot = join(ctx.directoryPath, 'proc');

  mkdirSync(join(procRoot, '42'), { recursive: true });
  writeFileSync(join(procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(procRoot, '42', 'cmdline'), `firecracker\0--api-sock\0${paths.apiSocket}\0`);
  writeFileSync(join(procRoot, '42', 'status'), 'Uid:\t900002\t900002\t0\t0\n');
  writeFileSync(join(procRoot, '42', 'cgroup'), '0::/imps/vm\n');

  expect(createVmRunner(buildStubJails().jails, { procRoot }).listVms()).toStrictEqual([
    { pid: 42, apiSocket: paths.apiSocket, owner: { uid: 900_002, cgroup: '/imps/vm' } },
  ]);
});

test('#readVmState reads no state once the API is gone', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  stopPid(vm.pid);

  await vm.exited;

  const state = await createVmRunner(buildStubJails().jails).readVmState(paths);

  expect(state).toBeNull();
});

test('#resumeVm seals the run dir, then patches the VM to resumed', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
  });

  const stub = buildStubJails();

  await createVmRunner(stub.jails).resumeVm(vm.pid, paths);

  expect(stub.notes).toStrictEqual(['remove uffd device vm', 'seal']);
  expect(readFileSync(ctx.logPath, 'utf8')).toBe('PATCH /vm {"state":"Resumed"}\n');
});

test('#resumeVm kills a VM whose seal finds anything planted in run/, and never resumes it', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const stub = buildStubJails();

  stub.refuseSeal(
    new Error('jail vm: the VM left planted in run/; a VM that writes there is compromised'),
  );

  expect(createVmRunner(stub.jails).resumeVm(vm.pid, paths)).rejects.toThrow(
    'a VM that writes there is compromised',
  );

  expect(existsSync(ctx.logPath)).toBeFalse();
  expect(probeProcessAlive(vm.pid, paths.apiSocket)).toBeFalse();
  expect(stub.notes).toStrictEqual(['remove uffd device vm', 'seal', 'release vm']);
});

test('#stopVm releases the jail on a hard stop, as a checkpoint restore asks', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const stub = buildStubJails();

  await createVmRunner(stub.jails).stopVm(vm.pid, paths, false);

  expect(probeProcessAlive(vm.pid, paths.apiSocket)).toBeFalse();
  expect(stub.notes).toStrictEqual(['release vm']);
});

test('#isVmAlive reads the liveness of a VM from the given /proc', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  mkdirSync(join(ctx.directoryPath, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.directoryPath, 'proc', '42', 'cmdline'),
    `firecracker\0--api-sock\0${paths.apiSocket}\0`,
  );

  const runner = createVmRunner(buildStubJails().jails, {
    procRoot: join(ctx.directoryPath, 'proc'),
  });

  expect(runner.probeVmAlive(42, paths)).toBeTrue();
});

test('#stopVm only releases the jail of a VM the given /proc shows gone', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const stub = buildStubJails();

  mkdirSync(join(ctx.directoryPath, 'proc'));

  await createVmRunner(stub.jails, { procRoot: join(ctx.directoryPath, 'proc') }).stopVm(
    42,
    paths,
    true,
  );

  expect(stub.notes).toStrictEqual(['release vm']);
});

test('#wakeVm releases the mounts of a jail prepare that fails partway, and restores the limit', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const calls: string[] = [];

  const stub = buildStubJails({
    onNote: (note) => {
      calls.push(note);
    },
  });

  stub.refusePrepare(new Error('mount --rbind: no space'));

  expect(
    createVmRunner(stub.jails).wakeVm({
      firecrackerBin: 'firecracker',
      paths,
      cgroup: {
        procsPath: '/nonexistent',
        liftLimit: () => {
          calls.push('lifted');
        },
        applyLimit: () => {
          calls.push('applied');
        },
      },
      jail: { uid: 900_000, gid: 900_000 },
      readOnlyFiles: [],
    }),
  ).rejects.toThrowWithMessage(Error, 'mount --rbind: no space');

  expect(calls).toStrictEqual([
    'lifted',
    'prepare vm late=false disk=true',
    'release vm',
    'applied',
  ]);
});

test('#wakeVm starts a jailed VM through the merge wrapper, which runs the jailer outside the chroot', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const wrapper = createStubKsmExec(ctx.directoryPath);

  const command = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: join(ctx.directoryPath, 'jail'),
    impId: 'vm',
    user: { uid: 900_000, gid: 900_000 },
    apiSocket: paths.apiSocket,
  });

  expect(
    createVmRunner(buildStubJails({ argv: command }).jails, { mergeWrapper: wrapper.path }).wakeVm({
      firecrackerBin: 'firecracker',
      paths,
      cgroup: null,
      jail: { uid: 900_000, gid: 900_000 },
      readOnlyFiles: [],
    }),
  ).rejects.toThrow('did not open its API socket');

  expect(wrapper.readArgv()).toStrictEqual([...command]);
});

test('#wakeVm loads the snapshot with dirty page tracking, so the next sleep takes a diff', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const argv = buildStubFirecrackerArgv({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    failures: ['PATCH /vm'],
  });

  const waking = createVmRunner(buildStubJails({ argv }).jails).wakeVm({
    firecrackerBin: 'firecracker',
    paths,
    cgroup: null,
    jail: { uid: 900_000, gid: 900_000 },
    readOnlyFiles: [],
  });

  expect(waking).rejects.toThrow('refused PATCH /vm');

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    `PUT /snapshot/load {"snapshot_path":"${paths.vmstate}","mem_backend":{"backend_type":"File","backend_path":"${paths.memFile}"},"resume_vm":false,"track_dirty_pages":true}`,
    'PATCH /vm {"state":"Resumed"}',
  ]);
});

test('#wakeVm removes the userfaultfd node of the jail after the load and before the seal', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, '');

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PATCH /vm'],
    }),
    onNote: (note) => {
      appendFileSync(ctx.logPath, `${note}\n`);
    },
  });

  const waking = createVmRunner(stub.jails, { uffdHandlerBin: handler.path }).wakeVm({
    firecrackerBin: 'firecracker',
    paths,
    cgroup: null,
    jail: { uid: 900_000, gid: 900_000 },
    readOnlyFiles: [],
    hugePages: '2M',
  });

  expect(waking).rejects.toThrow('refused PATCH /vm');

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n').slice(1)).toStrictEqual([
    'PUT /snapshot/load',
    'remove uffd device vm',
    'seal',
    'PATCH /vm',
    'release vm',
  ]);
});

test('#wakeVm loads a 2M snapshot through its page handler on 2 MiB pages, with no dirty page tracking', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, 'guest pages');

  const argv = buildStubFirecrackerArgv({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    failures: ['PATCH /vm'],
  });

  const waking = createVmRunner(buildStubJails({ argv }).jails, {
    uffdHandlerBin: handler.path,
  }).wakeVm({
    firecrackerBin: 'firecracker',
    paths,
    cgroup: null,
    jail: { uid: 900_000, gid: 900_000 },
    readOnlyFiles: [],
    hugePages: '2M',
  });

  expect(waking).rejects.toThrow('refused PATCH /vm');

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    `PUT /snapshot/load {"snapshot_path":"${paths.vmstate}","mem_backend":{"backend_type":"Uffd","backend_path":"${paths.uffdSocket}"},"resume_vm":false,"huge_pages":"2M"}`,
    'PATCH /vm {"state":"Resumed"}',
  ]);

  expect(handler.readStarts()).toStrictEqual([
    {
      options: { socket: paths.uffdSocket, uid: '900000', gid: '900000' },
      served: 'guest pages',
    },
  ]);
});

test('#wakeVm stops the page handler of a 2M wake that fails', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, '');

  const argv = buildStubFirecrackerArgv({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm'],
  });

  const waking = createVmRunner(buildStubJails({ argv }).jails, {
    uffdHandlerBin: handler.path,
  }).wakeVm({
    firecrackerBin: 'firecracker',
    paths,
    cgroup: null,
    jail: { uid: 900_000, gid: 900_000 },
    readOnlyFiles: [],
    hugePages: '2M',
  });

  expect(waking).rejects.toThrow('refused PATCH /vm');

  await waitFor(() => {
    expect(readHandlerState(paths).state).toBe('gone');
  });
});

test('#wakeVm refuses a 2M snapshot with no page handler before it loads', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const argv = buildStubFirecrackerArgv({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
  });

  const waking = createVmRunner(buildStubJails({ argv }).jails).wakeVm({
    firecrackerBin: 'firecracker',
    paths,
    cgroup: null,
    jail: { uid: 900_000, gid: 900_000 },
    readOnlyFiles: [],
    hugePages: '2M',
  });

  expect(waking).rejects.toThrow('IMP_HUGE_PAGES is off');
  expect(existsSync(ctx.logPath)).toBeFalse();
});

test('#wakeVm loads a 2M snapshot on host pages with dirty page tracking when it is asked for none', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const argv = buildStubFirecrackerArgv({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    failures: ['PATCH /vm'],
  });

  const waking = createVmRunner(buildStubJails({ argv }).jails).wakeVm({
    firecrackerBin: 'firecracker',
    paths,
    cgroup: null,
    jail: { uid: 900_000, gid: 900_000 },
    readOnlyFiles: [],
    hugePages: 'None',
  });

  expect(waking).rejects.toThrow('refused PATCH /vm');

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    `PUT /snapshot/load {"snapshot_path":"${paths.vmstate}","mem_backend":{"backend_type":"File","backend_path":"${paths.memFile}"},"resume_vm":false,"track_dirty_pages":true,"huge_pages":"None"}`,
    'PATCH /vm {"state":"Resumed"}',
  ]);
});

test('#sleepVm writes the blocks a woken 2M VM holds over a copy of the file its page handler serves', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.memFile, `${'a'.repeat(4096)}${'b'.repeat(4096)}${'c'.repeat(4096)}`);

  const handlerPid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile: paths.memFile,
    jail: null,
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(handlerPid);
  });

  rmSync(paths.memFile);

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: {
      pages: 'ABC',
      dirtyPages: [],
      isTrackingDirtyPages: false,
      hugePages: '2M',
      presentPages: [1],
    },
  });

  const timings = await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(readFileSync(paths.memFile, 'latin1')).toBe(
    `${'a'.repeat(4096)}${'B'.repeat(4096)}${'c'.repeat(4096)}`,
  );

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'GET /machine-config',
    'PATCH /vm {"state":"Paused"}',
    `PUT /snapshot/create {"snapshot_type":"Diff","snapshot_path":"${paths.vmstate}.new","mem_file_path":"${paths.memFile}.new","sync_snapshot_files":true}`,
  ]);

  expect(timings).toContainKey('copyBase');
});

test('#sleepVm writes the blocks a cold-booted 2M VM holds over an empty memory file', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
    memory: {
      pages: 'AB',
      dirtyPages: [],
      isTrackingDirtyPages: false,
      hugePages: '2M',
      presentPages: [0],
    },
  });

  const timings = await createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths);

  expect(readFileSync(paths.memFile, 'latin1')).toBe(`${'A'.repeat(4096)}${'\0'.repeat(4096)}`);
  expect(readFileSync(ctx.logPath, 'utf8')).toInclude('{"snapshot_type":"Diff"');
  expect(timings).not.toContainKey('copyBase');
});

test('#sleepVm refuses a 2M VM whose page handler is gone and leaves it running', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({
    apiSocket: paths.apiSocket,
    logPath: ctx.logPath,
    memory: { pages: 'AB', dirtyPages: [], isTrackingDirtyPages: false, hugePages: '2M' },
  });

  writeFileSync(paths.uffdPidFile, '999999999\n');

  expect(
    createVmRunner(buildStubJails().jails).sleepVm(vm.pid, paths, null, paths),
  ).rejects.toThrowWithMessage(Error, 'its page handler is gone, so its memory cannot be read');

  expect(probeProcessAlive(vm.pid, paths.apiSocket)).toBeTrue();
  expect(existsSync(paths.memFile)).toBeFalse();
});

test('#watchUffdHandler stops a VM whose page handler dies', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);

  writeFileSync(join(ctx.directoryPath, 'mem'), '');

  const vm = await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const handlerPid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile: join(ctx.directoryPath, 'mem'),
    jail: null,
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(handlerPid);
  });

  createVmRunner(buildStubJails().jails).watchUffdHandler(vm.pid, paths);

  process.kill(handlerPid, 'SIGKILL');

  expect(vm.exited).resolves.not.toBe(0);
});
