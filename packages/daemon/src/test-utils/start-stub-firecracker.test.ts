import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFirecrackerAlive } from '../vmm/firecracker-process';
import { buildStubFirecrackerArgv, startStubFirecracker } from './start-stub-firecracker';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-fc-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, apiSocket: join(dir, 'api.sock'), logPath: join(dir, 'calls.log') };
}

test('it builds a command that names the API socket after --api-sock', () => {
  const argv = buildStubFirecrackerArgv({ apiSocket: '/r/api.sock', logPath: '/r/log' });

  expect(argv.slice(-6)).toStrictEqual([
    '--api-sock',
    '/r/api.sock',
    '/r/log',
    'none',
    'lines',
    'none',
  ]);
});

test('it answers that its guest tracks the pages it dirties', async () => {
  const ctx = setupTest();

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    memory: { pages: 'ab', dirtyPages: [], isTrackingDirtyPages: true },
  });

  const response = await fetch('http://localhost/machine-config', { unix: ctx.apiSocket });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    vcpu_count: 1,
    mem_size_mib: 128,
    smt: false,
    track_dirty_pages: true,
    huge_pages: 'None',
  });
});

test('it writes every page of its guest on a full snapshot', async () => {
  const ctx = setupTest();

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    memory: { pages: 'aBc', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  await fetch('http://localhost/snapshot/create', {
    unix: ctx.apiSocket,
    method: 'PUT',
    body: JSON.stringify({
      snapshot_type: 'Full',
      snapshot_path: join(ctx.dir, 'vmstate'),
      mem_file_path: join(ctx.dir, 'mem'),
    }),
  });

  expect(readFileSync(join(ctx.dir, 'mem'), 'latin1')).toBe(
    `${'a'.repeat(4096)}${'B'.repeat(4096)}${'c'.repeat(4096)}`,
  );

  expect(readFileSync(join(ctx.dir, 'vmstate'), 'utf8')).toBe('vmstate');
});

test('it writes only the dirty pages over a mem file of the guest size on a diff snapshot', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'mem'), 'x'.repeat(3 * 4096));

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    memory: { pages: 'aBc', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  await fetch('http://localhost/snapshot/create', {
    unix: ctx.apiSocket,
    method: 'PUT',
    body: JSON.stringify({
      snapshot_type: 'Diff',
      snapshot_path: join(ctx.dir, 'vmstate'),
      mem_file_path: join(ctx.dir, 'mem'),
    }),
  });

  expect(readFileSync(join(ctx.dir, 'mem'), 'latin1')).toBe(
    `${'x'.repeat(4096)}${'B'.repeat(4096)}${'x'.repeat(4096)}`,
  );
});

test('it empties a mem file of another size before a diff snapshot', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'mem'), 'x'.repeat(4096));

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    memory: { pages: 'aB', dirtyPages: [1], isTrackingDirtyPages: true },
  });

  await fetch('http://localhost/snapshot/create', {
    unix: ctx.apiSocket,
    method: 'PUT',
    body: JSON.stringify({
      snapshot_type: 'Diff',
      snapshot_path: join(ctx.dir, 'vmstate'),
      mem_file_path: join(ctx.dir, 'mem'),
    }),
  });

  expect(readFileSync(join(ctx.dir, 'mem'), 'latin1')).toBe(
    `${'\0'.repeat(4096)}${'B'.repeat(4096)}`,
  );
});

test('it runs as a process the liveness check takes for a Firecracker', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  expect(isFirecrackerAlive(vm.pid, ctx.apiSocket)).toBeTrue();
});

test('it answers a PUT with 204 and logs its method and path', async () => {
  const ctx = setupTest();

  await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  const response = await fetch('http://localhost/actions', {
    unix: ctx.apiSocket,
    method: 'PUT',
    body: '{"action_type":"InstanceStart"}',
  });

  expect(response.status).toBe(204);
  expect(readFileSync(ctx.logPath, 'utf8')).toBe('PUT /actions\n');
});

test('it logs the body too when asked to', async () => {
  const ctx = setupTest();

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
  });

  await fetch('http://localhost/vm', {
    unix: ctx.apiSocket,
    method: 'PATCH',
    body: '{"state":"Paused"}',
  });

  expect(readFileSync(ctx.logPath, 'utf8')).toBe('PATCH /vm {"state":"Paused"}\n');
});

test('it fails a call that starts with one of its failures with a fault message', async () => {
  const ctx = setupTest();

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm {"state":"Paused"}'],
  });

  const response = await fetch('http://localhost/vm', {
    unix: ctx.apiSocket,
    method: 'PATCH',
    body: '{"state":"Paused"}',
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(400);
  expect(body).toStrictEqual({ fault_message: 'refused PATCH /vm' });
});

test('it answers a call that matches none of its failures', async () => {
  const ctx = setupTest();

  await startStubFirecracker({
    apiSocket: ctx.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm {"state":"Paused"}'],
  });

  const response = await fetch('http://localhost/vm', {
    unix: ctx.apiSocket,
    method: 'PATCH',
    body: '{"state":"Resumed"}',
  });

  expect(response.status).toBe(204);
});

test('it answers its version', async () => {
  const ctx = setupTest();

  await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  const response = await fetch('http://localhost/version', { unix: ctx.apiSocket });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ firecracker_version: 'v1.17.0' });
});

test('it answers a running VM state at first', async () => {
  const ctx = setupTest();

  await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  const response = await fetch('http://localhost/', { unix: ctx.apiSocket });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ id: 'anonymous-instance', state: 'Running' });
});

test('it answers the state a pause set', async () => {
  const ctx = setupTest();

  await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  await fetch('http://localhost/vm', {
    unix: ctx.apiSocket,
    method: 'PATCH',
    body: '{"state":"Paused"}',
  });

  const response = await fetch('http://localhost/', { unix: ctx.apiSocket });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ id: 'anonymous-instance', state: 'Paused' });
});

test('it kills the process when the test ends', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  onTestFinished(async () => {
    const code = await vm.exited;

    expect(code).not.toBe(0);
  });
});
