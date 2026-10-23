import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubImpd } from './create-stub-impd';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-impd-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the network settings it was given for --network-env and exits 0', () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16', 'IMP_BROKER_PORT=7081'],
  });

  const result = Bun.spawnSync([impd.daemon, '--network-env']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'IMP_SUBNET=10.66.0.0/16\nIMP_BROKER_PORT=7081\n',
    stderr: '',
  });
});

test('it sends SIGTERM to its parent on a run by default', () => {
  const ctx = setupTest();
  const impd = createStubImpd(ctx.directoryPath, { networkEnv: ['IMP_SUBNET=10.66.0.0/16'] });
  const result = Bun.spawnSync(['bash', '-c', '"$0"; echo "parent ran on"', impd.daemon]);

  expect({ signalCode: result.signalCode, stdout: result.stdout.toString() }).toStrictEqual({
    signalCode: 'SIGTERM',
    stdout: '',
  });
});

test('it logs the variables it was told to record on each run', () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    recordEnv: ['IMP_TAILSCALE_NODE'],
  });

  // a trailing command keeps bash from exec-ing the stub, which would signal the test runner
  Bun.spawnSync(['bash', '-c', '"$0"; :', impd.daemon], { env: { IMP_TAILSCALE_NODE: '1' } });

  expect(readFileSync(impd.calls, 'utf8')).toBe('impd \n  IMP_TAILSCALE_NODE=1\n');
});

test('it logs no variables on --network-env', () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    recordEnv: ['IMP_TAILSCALE_NODE'],
  });

  Bun.spawnSync([impd.daemon, '--network-env']);

  expect(readFileSync(impd.calls, 'utf8')).toBe('impd --network-env\n');
});

test('it exits its first runs with the codes it was given, in order, then signals its parent', () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    exitCodes: [7, 3],
  });

  const result = Bun.spawnSync([
    'bash',
    '-c',
    '"$0"; echo "$?"; "$0"; echo "$?"; "$0"; echo "parent ran on"',
    impd.daemon,
  ]);

  expect({ signalCode: result.signalCode, stdout: result.stdout.toString() }).toStrictEqual({
    signalCode: 'SIGTERM',
    stdout: '7\n3\n',
  });
});

test('it never counts --network-env as a run', () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    exitCodes: [7],
  });

  Bun.spawnSync([impd.daemon, '--network-env']);

  const result = Bun.spawnSync(['bash', '-c', '"$0"; echo "$?"', impd.daemon]);

  expect(result.stdout.toString()).toBe('7\n');
});

test('it runs until SIGTERM, then logs it and exits 0, when told to wait for it', async () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    lastRun: 'wait-for-term',
  });

  const daemon = Bun.spawn([impd.daemon]);

  onTestFinished(() => {
    daemon.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(impd.probeRunning()).toBeTrue();
  });

  daemon.kill('SIGTERM');

  const exitCode = await daemon.exited;

  expect(exitCode).toBe(0);
  expect(readFileSync(impd.calls, 'utf8')).toBe('impd \nimpd got TERM\n');
});

test('it reports no run before one starts', () => {
  const ctx = setupTest();

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    lastRun: 'wait-for-term',
  });

  expect(impd.probeRunning()).toBeFalse();
});
