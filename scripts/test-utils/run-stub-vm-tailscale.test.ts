import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// run-stub-vm-tailscale.sh is the tailscale CLI of deploy/nixos/tests/vm.nix's stub image.
function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-vm-tailscale-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it reports NeedsLogin under no name with no saved state', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname,
      '--socket=/var/run/tailscale/tailscaled.sock',
      'status',
      '--json',
    ],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout:
      '{"BackendState":"NeedsLogin","Self":{"HostName":"none","TailscaleIPs":["100.64.0.1"],"DNSName":"none.example.ts.net."}}\n',
    stderr: '',
  });
});

test('it reports Running under the saved name for a valid state', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'tailscaled.state'), 'valid\n');
  writeFileSync(join(ctx.directoryPath, 'fake-hostname'), 'imp-vm\n');

  const result = Bun.spawnSync(
    ['bash', new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname, 'status', '--json'],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect(result.stdout.toString()).toBe(
    '{"BackendState":"Running","Self":{"HostName":"imp-vm","TailscaleIPs":["100.64.0.1"],"DNSName":"imp-vm.example.ts.net."}}\n',
  );
});

test('it reports Starting for a starting state', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'tailscaled.state'), 'starting\n');

  const result = Bun.spawnSync(
    ['bash', new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname, 'status', '--json'],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect(result.stdout.toString()).toBe(
    '{"BackendState":"Starting","Self":{"HostName":"none","TailscaleIPs":["100.64.0.1"],"DNSName":"none.example.ts.net."}}\n',
  );
});

test('it reports NeedsLogin for a stale state', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'tailscaled.state'), 'stale\n');

  const result = Bun.spawnSync(
    ['bash', new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname, 'status', '--json'],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect(result.stdout.toString()).toBe(
    '{"BackendState":"NeedsLogin","Self":{"HostName":"none","TailscaleIPs":["100.64.0.1"],"DNSName":"none.example.ts.net."}}\n',
  );
});

test('it logs the arguments of an up with a key', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'authkey'), 'tskey-auth-test\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname,
      'up',
      `--auth-key=file:${join(ctx.directoryPath, 'authkey')}`,
      '--hostname=imp-vm',
    ],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directoryPath, 'fake-up.log'), 'utf8')).toBe(
    `up up --auth-key=file:${join(ctx.directoryPath, 'authkey')} --hostname=imp-vm\n`,
  );
});

test('it saves a valid state under the up hostname', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'authkey'), 'tskey-auth-test\n');

  Bun.spawnSync(
    [
      'bash',
      new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname,
      'up',
      `--auth-key=file:${join(ctx.directoryPath, 'authkey')}`,
      '--hostname=imp-vm',
    ],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  const result = Bun.spawnSync(
    ['bash', new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname, 'status', '--json'],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect(result.stdout.toString()).toBe(
    '{"BackendState":"Running","Self":{"HostName":"imp-vm","TailscaleIPs":["100.64.0.1"],"DNSName":"imp-vm.example.ts.net."}}\n',
  );
});

test('it refuses an up whose key file is empty', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'authkey'), '');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname,
      'up',
      `--auth-key=file:${join(ctx.directoryPath, 'authkey')}`,
    ],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `fake tailscale: no key in ${join(ctx.directoryPath, 'authkey')}\n`,
  });
});

test('it refuses an up with a single-use key that joined already', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'authkey'), 'used-key\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname,
      'up',
      `--auth-key=file:${join(ctx.directoryPath, 'authkey')}`,
    ],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'backend error: invalid key: unable to validate API key\n',
  });
});

test('it logs no up that it refuses', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'authkey'), 'used-key\n');

  Bun.spawnSync(
    [
      'bash',
      new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname,
      'up',
      `--auth-key=file:${join(ctx.directoryPath, 'authkey')}`,
    ],
    { env: { PATH: process.env['PATH'] ?? '', STUB_TAILSCALE_DIR: ctx.directoryPath } },
  );

  expect(existsSync(join(ctx.directoryPath, 'fake-up.log'))).toBe(false);
});

test('it refuses to run without its state dir', () => {
  const result = Bun.spawnSync(
    ['bash', new URL('run-stub-vm-tailscale.sh', import.meta.url).pathname, 'status', '--json'],
    { env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toInclude('STUB_TAILSCALE_DIR');
});
