import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildStubJails } from '../../testing/vm/build-stub-jails';
import { createStubKsmExec } from '../../testing/vm/create-stub-ksm-exec';
import { startStubAgent } from '../../testing/vm/start-stub-agent';
import {
  buildStubFirecrackerArgv,
  startStubFirecracker,
} from '../../testing/vm/start-stub-firecracker';
import { PingSchema } from '../agent-client/agent-protocol';
import { sendPing } from '../agent-client/agent-requests';
import { FRAME_TYPES, encodeJsonFrame } from '../agent-client/frame-codec';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { stopPid } from '../process/proc';
import { buildImpPaths, buildSnapshotPaths } from '../storage/data-layout';
import { isFirecrackerAlive } from './firecracker-process';
import { buildJailerCommand } from './jail';
import { createVmRunner } from './vm-runner';

// A temp dir and the log the stub VMM appends its calls to. `createImpDir`
// makes the run/ and the disk of the imp a test names, which a sleep needs for
// its snapshot's owner.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const createImpDir = (impId: string) => {
    const paths = buildImpPaths(dir, impId);

    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.disk, '');

    return paths;
  };

  return { dir, createImpDir, logPath: join(dir, 'calls.log') };
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
  expect(isFirecrackerAlive(vm.pid, paths.apiSocket)).toBeTrue();
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

  expect(isFirecrackerAlive(vm.pid, paths.apiSocket)).toBeFalse();
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
  const slot = buildSnapshotPaths(join(paths.dir, 'watchdog'));

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

// the failed snapshot may have cleared the dirty page log, so a later diff
// over that file could miss pages
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
  expect(isFirecrackerAlive(vm.pid, paths.apiSocket)).toBeTrue();
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

// a sleep asks under the imp's lock: far below a ping's default of 2 s
test('#readGuestUptimeMs asks the agent with a 250 ms deadline', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const ping = mock(() =>
    Promise.resolve(create(PingSchema, { ok: true, version: '0.1.0', uptimeMs: 1350 })),
  );

  const uptime = await createVmRunner(buildStubJails().jails, null, ping).readGuestUptimeMs(paths);

  expect(uptime).toBe(1350);
  expect(ping).toHaveBeenCalledWith(paths.vsockSocket, 250);
});

test('#readGuestUptimeMs reads no uptime from an agent that does not answer by the deadline', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  // accepts the connection and never answers
  await startStubAgent(paths.vsockSocket, () => {});

  const uptime = await createVmRunner(buildStubJails().jails, null, (vsockPath) =>
    sendPing(vsockPath, 20),
  ).readGuestUptimeMs(paths);

  expect(uptime).toBeNull();
});

test('#readGuestUptimeMs reads no uptime from an agent that cannot read its clock', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  await startStubAgent(paths.vsockSocket, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0' }));
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

  // the spawn removes a stale agent socket, so the agent comes after it
  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  onTestFinished(() => {
    stopPid(pid);
  });

  await startStubAgent(paths.vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        ok: true,
        version: '0.1.0',
        boot_steps: [
          { name: 'world', ms: 9 },
          { name: 'mount', ms: 35 },
          { name: 'ready', ms: 1 },
        ],
      }),
    );
  });

  const vm = await starting;

  expect(vm.guestSteps).toStrictEqual({ world: 9, mount: 35, ready: 1 });
});

test('#readVmState reads the VM state from the API', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const state = await createVmRunner(buildStubJails().jails).readVmState(paths);

  expect(state).toBe('Running');
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

  expect(stub.notes).toStrictEqual(['seal']);
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
  expect(isFirecrackerAlive(vm.pid, paths.apiSocket)).toBeFalse();
  expect(stub.notes).toStrictEqual(['seal', 'release vm']);
});

test('#stopVm releases the jail on a hard stop, as a checkpoint restore asks', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  const vm = await startStubFirecracker({ apiSocket: paths.apiSocket, logPath: ctx.logPath });

  const stub = buildStubJails();

  await createVmRunner(stub.jails).stopVm(vm.pid, paths, false);

  expect(isFirecrackerAlive(vm.pid, paths.apiSocket)).toBeFalse();
  expect(stub.notes).toStrictEqual(['release vm']);
});

test('#isVmAlive reads the liveness of a VM from the given /proc', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  mkdirSync(join(ctx.dir, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.dir, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.dir, 'proc', '42', 'cmdline'),
    `firecracker\0--api-sock\0${paths.apiSocket}\0`,
  );

  const runner = createVmRunner(buildStubJails().jails, null, sendPing, join(ctx.dir, 'proc'));

  expect(runner.isVmAlive(42, paths)).toBeTrue();
});

test('#stopVm only releases the jail of a VM the given /proc shows gone', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const stub = buildStubJails();

  mkdirSync(join(ctx.dir, 'proc'));

  await createVmRunner(stub.jails, null, sendPing, join(ctx.dir, 'proc')).stopVm(42, paths, true);

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
  const wrapper = createStubKsmExec(ctx.dir);

  const command = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: join(ctx.dir, 'jail'),
    impId: 'vm',
    user: { uid: 900_000, gid: 900_000 },
    apiSocket: paths.apiSocket,
  });

  expect(
    createVmRunner(buildStubJails({ argv: command }).jails, wrapper.path).wakeVm({
      firecrackerBin: 'firecracker',
      paths,
      cgroup: null,
      jail: { uid: 900_000, gid: 900_000 },
      readOnlyFiles: [],
    }),
  ).rejects.toThrow('did not open its API socket');

  expect(wrapper.readArgv()).toStrictEqual([...command]);
});

// the resume fails, so the wake ends right after the load it logged
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
