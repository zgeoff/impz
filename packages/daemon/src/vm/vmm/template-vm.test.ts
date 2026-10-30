import { expect, onTestFinished, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildMockTemplateBuildPlan } from '../../../testing/vm/build-mock-template-build-plan';
import { buildMockTemplateRestorePlan } from '../../../testing/vm/build-mock-template-restore-plan';
import { buildStubJails } from '../../../testing/vm/build-stub-jails';
import { createStubUffdHandler } from '../../../testing/vm/create-stub-uffd-handler';
import { buildStubFirecrackerArgv } from '../../../testing/vm/start-stub-firecracker';
import { startStubParkedAgent } from '../../../testing/vm/start-stub-parked-agent';
import { stopPid } from '../../platform/process/proc';
import { buildImpPaths } from '../storage/data-layout';
import { createFirecrackerClient } from './firecracker-client';
import { probeProcessAlive } from './firecracker-process';
import { TemplateRestoreError, createTemplateVm, loadTemplateVm } from './template-vm';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-tpl-vm-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory, logPath: join(directory, 'calls.log') };
}

test('#loadTemplateVm owns the disk of a jailed restore once the clone is done, before it patches the drive', async () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath }),
    onNote: (note) => {
      appendFileSync(ctx.logPath, `${note}\n`);
    },
  });

  const clone = Promise.withResolvers<number>();

  const plan = buildMockTemplateRestorePlan({
    paths,
    jail: { uid: 900_001, gid: 900_001 },
    diskReady: clone.promise,
  });

  const restoring = loadTemplateVm(plan, stub.jails);

  await waitFor(() => {
    expect(existsSync(paths.pidFile)).toBeTrue();
  });

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  onTestFinished(() => {
    stopPid(pid);
  });

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(paths.vsockSocket);

  await waitFor(() => {
    expect(readFileSync(ctx.logPath, 'utf8')).toInclude('PATCH /vm\n');
  });

  writeFileSync(paths.disk, '');

  clone.resolve(0);

  await restoring;

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'prepare i1 late=true disk=false',
    'PUT /snapshot/load',
    'remove uffd device i1',
    'seal',
    'PATCH /vm',
    'own disk=true',
    'PATCH /drives/rootfs',
    'GET /version',
  ]);

  // Firecracker fails a jailed load unless the drive the snapshot names is
  // bound in
  expect(stub.plans).toStrictEqual([
    {
      impId: 'i1',
      user: { uid: 900_001, gid: 900_001 },
      paths,
      readOnlyFiles: [plan.vmstate, plan.memFile, plan.systemDrivePath],
      scratchFiles: [plan.placeholderPath],
      isDiskLate: true,
    },
  ]);
});

test('#loadTemplateVm fails a restore whose load fails as a fault of the template', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT /snapshot/load'],
    }),
  });

  const restoring = loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
    stub.jails,
  );

  expect(restoring).rejects.toBeInstanceOf(TemplateRestoreError);
  expect(restoring).rejects.toMatchObject({ fault: 'load' });
  expect(restoring).rejects.toThrow(/^template restore failed: /u);
});

test('#loadTemplateVm fails a restore whose parked agent never answers as an agent fault', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath }),
  });

  const restoring = loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
    stub.jails,
    { parkedAgentMs: 300 },
  );

  expect(restoring).rejects.toBeInstanceOf(TemplateRestoreError);
  expect(restoring).rejects.toMatchObject({ fault: 'agent' });
});

test('#loadTemplateVm fails a restore whose drive patch fails as a fault of the imp', async () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.disk, '');

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PATCH /drives'],
    }),
  });

  const restoring = loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
    stub.jails,
  );

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(paths.vsockSocket);

  expect(restoring).rejects.toBeInstanceOf(TemplateRestoreError);
  expect(restoring).rejects.toMatchObject({ fault: null });
});

test('#loadTemplateVm returns the steps the claimed guest reports for its boot', async () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.disk, '');

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath }),
  });

  const restoring = loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
    stub.jails,
  );

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  onTestFinished(() => {
    stopPid(pid);
  });

  await startStubParkedAgent(paths.vsockSocket);

  const vm = await restoring;

  expect(vm.guestSteps).toStrictEqual({ claim: 3, mount: 40, ready: 2 });
});

test('#loadTemplateVm kills the VM and releases the jail of a restore that fails', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT /snapshot/load'],
    }),
  });

  expect(
    loadTemplateVm(
      buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
      stub.jails,
    ),
  ).rejects.toThrow();

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  expect(probeProcessAlive(pid, paths.apiSocket)).toBeFalse();
  expect(stub.notes.at(-1)).toBe('release i1');
});

test('#loadTemplateVm asks Firecracker through the client factory it is given', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');
  const sockets: string[] = [];

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT /snapshot/load'],
    }),
  });

  expect(
    loadTemplateVm(
      buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
      stub.jails,
      {
        createClient: (socketPath, timeouts) => {
          sockets.push(socketPath);

          return createFirecrackerClient(socketPath, timeouts);
        },
      },
    ),
  ).rejects.toThrow();

  expect(sockets).toStrictEqual([paths.apiSocket]);
});

test('#loadTemplateVm releases the jail of a restore whose prepare fails, and passes the error on', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');
  const stub = buildStubJails({ argv: [] });

  stub.refusePrepare(new Error('mount --rbind: no space'));

  expect(
    loadTemplateVm(
      buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
      stub.jails,
    ),
  ).rejects.toThrowWithMessage(Error, 'mount --rbind: no space');

  expect(stub.notes).toStrictEqual(['prepare i1 late=true disk=false', 'release i1']);
});

test('#buildTemplateVm releases the jail of a build before its files go to root, readable by all', async () => {
  const ctx = setupTest();

  // the test's own uid, because a chown to another uid needs root
  const user = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: user,
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: plan.paths.apiSocket, logPath: ctx.logPath }),
    onNote: (note) => {
      appendFileSync(ctx.logPath, `${note}\n`);
    },
  });

  const memModes: string[] = [];

  const building = createTemplateVm(plan, {
    ...stub.jails,
    release: (id) => {
      memModes.push((lstatSync(plan.memFile).mode & 0o777).toString(8));

      return stub.jails.release(id);
    },
  });

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  const calls = readFileSync(ctx.logPath, 'utf8').trim().split('\n');

  expect(calls).toStrictEqual([
    'prepare build tpl-build',
    'PUT /boot-source',
    'PUT /machine-config',
    'PUT /drives/rootfs',
    'PUT /drives/system',
    'PUT /vsock',
    'PUT /network-interfaces/eth0',
    'PUT /balloon',
    'remove uffd device tpl-build',
    'seal',
    'PUT /actions',
    'PATCH /vm',
    'PUT /snapshot/create',
    'release tpl-build',
  ]);

  expect(memModes).toStrictEqual(['600']);
  expect(lstatSync(plan.memFile).mode & 0o777).toBe(0o644);
  expect(lstatSync(plan.vmstate).mode & 0o777).toBe(0o644);
});

test('#buildTemplateVm binds the kernel and the system drive into a jailed build read-only', async () => {
  const ctx = setupTest();
  const user = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: user,
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: plan.paths.apiSocket, logPath: ctx.logPath }),
  });

  const building = createTemplateVm(plan, stub.jails);

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  expect(stub.plans).toStrictEqual([
    {
      id: 'tpl-build',
      user,
      workDir: plan.workDir,
      paths: plan.paths,
      readOnlyFiles: [plan.kernelPath, plan.systemDrivePath],
      scratchFiles: [plan.placeholderPath],
    },
  ]);
});

test('#buildTemplateVm configures the VM through the client factory it is given', async () => {
  const ctx = setupTest();
  const sockets: string[] = [];

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: plan.paths.apiSocket, logPath: ctx.logPath }),
  });

  const building = createTemplateVm(plan, stub.jails, {
    createClient: (socketPath, timeouts) => {
      sockets.push(socketPath);

      return createFirecrackerClient(socketPath, timeouts);
    },
  });

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  expect(sockets).toStrictEqual([plan.paths.apiSocket]);
});

test('#buildTemplateVm fails a build whose VM refuses its config', () => {
  const ctx = setupTest();

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: plan.paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT '],
    }),
  });

  expect(createTemplateVm(plan, stub.jails)).rejects.toThrow(/^template build failed: /u);
});

test('#buildTemplateVm releases the jail of a build that fails, and leaves no snapshot', () => {
  const ctx = setupTest();

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: plan.paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT '],
    }),
  });

  expect(createTemplateVm(plan, stub.jails)).rejects.toThrow();
  expect(stub.notes.at(-1)).toBe('release tpl-build');
  expect(existsSync(plan.snapshotDir)).toBeFalse();
});

test('#buildTemplateVm boots a 2M build on 2 MiB pages and snapshots only the blocks it holds', async () => {
  const ctx = setupTest();

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.directoryPath, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    hugePages: '2M',
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: plan.paths.apiSocket,
      logPath: ctx.logPath,
      isLoggingBodies: true,
    }),
  });

  const building = createTemplateVm(plan, stub.jails);

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  const calls = readFileSync(ctx.logPath, 'utf8').trim().split('\n');

  expect(calls.find((call) => call.startsWith('PUT /machine-config'))).toInclude(
    '"huge_pages":"2M"',
  );

  expect(calls.find((call) => call.startsWith('PUT /snapshot/create'))).toInclude(
    '"snapshot_type":"Diff"',
  );
});

test('#loadTemplateVm restores a 2M template through its page handler on 2 MiB pages', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(memFile, 'template pages');

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      isLoggingBodies: true,
      failures: ['PATCH /vm'],
    }),
  });

  const plan = buildMockTemplateRestorePlan({
    paths,
    memFile,
    hugePages: '2M',
    tap: 'imp-t1',
    jail: { uid: 900_001, gid: 900_001 },
  });

  const restoring = loadTemplateVm(plan, stub.jails, { uffdHandlerBin: handler.path });

  expect(restoring).rejects.toThrow(/^template restore failed: /u);

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    `PUT /snapshot/load {"snapshot_path":"${plan.vmstate}","mem_backend":{"backend_type":"Uffd","backend_path":"${paths.uffdSocket}"},"resume_vm":false,"huge_pages":"2M","network_overrides":[{"iface_id":"eth0","host_dev_name":"imp-t1"}],"vsock_override":{"uds_path":"${paths.vsockSocket}"}}`,
    'PATCH /vm {"state":"Resumed"}',
  ]);

  expect(handler.readStarts()).toStrictEqual([
    {
      options: { socket: paths.uffdSocket, uid: '900001', gid: '900001' },
      served: 'template pages',
    },
  ]);
});

test('#loadTemplateVm restores a host-page template from its memory file', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.directoryPath, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      isLoggingBodies: true,
      failures: ['PATCH /vm'],
    }),
  });

  const plan = buildMockTemplateRestorePlan({
    paths,
    tap: 'imp-t1',
    jail: { uid: 900_001, gid: 900_001 },
  });

  const restoring = loadTemplateVm(plan, stub.jails);

  expect(restoring).rejects.toThrow(/^template restore failed: /u);

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    `PUT /snapshot/load {"snapshot_path":"${plan.vmstate}","mem_backend":{"backend_type":"File","backend_path":"${plan.memFile}"},"resume_vm":false,"network_overrides":[{"iface_id":"eth0","host_dev_name":"imp-t1"}],"vsock_override":{"uds_path":"${paths.vsockSocket}"}}`,
    'PATCH /vm {"state":"Resumed"}',
  ]);
});
