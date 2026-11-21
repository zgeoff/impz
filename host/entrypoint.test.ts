import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubImpd } from '@impz/scripts/test-utils/create-stub-impd';
import { createStubShellScript } from '@impz/scripts/test-utils/create-stub-shell-script';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { waitFor } from '@zgeoff/testing';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-entrypoint-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    script: new URL('entrypoint', import.meta.url).pathname,
  };
}

test('it runs the repo impd source under bun when IMP_DAEMON is unset', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'bun', { script: '#!/bin/bash\nexit 1' });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`, IMP_LIB: ctx.directoryPath },
  });

  expect(result.exitCode).toBe(1);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'bun /src/packages/daemon/src/main.ts --network-env\n',
  );
});

test('it runs a .ts IMP_DAEMON under bun', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'bun', { script: '#!/bin/bash\nexit 1' });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: '/opt/impd/main.ts',
    },
  });

  expect(result.exitCode).toBe(1);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'bun /opt/impd/main.ts --network-env\n',
  );
});

test('it stops the container with impd’s exit code when the compiled impd refuses a setting', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'bun');
  createStubShellScript(ctx.directoryPath, 'setup-cgroups');

  createStubBin(ctx.directoryPath, 'impd', {
    script: "#!/bin/bash\necho 'impd: IMP_SUBNET is not a CIDR' >&2; exit 3",
  });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 3,
    stdout: '',
    stderr: 'impd: IMP_SUBNET is not a CIDR\n',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('impd --network-env\n');
});

test('it exports impd’s network settings, runs each setup script in order, then impd', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-cgroups');
  createStubShellScript(ctx.directoryPath, 'setup-storage');

  createStubShellScript(ctx.directoryPath, 'setup-net', {
    recordEnv: ['IMP_SUBNET', 'IMP_BROKER_PORT'],
  });

  createStubShellScript(ctx.directoryPath, 'tailscale-up');

  createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16', 'IMP_BROKER_PORT=7081'],
    recordEnv: ['IMP_TAILSCALE_NODE'],
  });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
      IMP_TAILSCALE_SOCKET: join(ctx.directoryPath, 'tailscaled.sock'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'impd --network-env',
    'setup-cgroups ',
    'setup-storage ',
    'setup-net ',
    '  IMP_SUBNET=10.66.0.0/16 IMP_BROKER_PORT=7081',
    'tailscale-up ',
    'impd ',
    '  IMP_TAILSCALE_NODE=',
    '',
  ]);
});

test('it stops the container before impd when a setup script fails', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-cgroups');

  createStubShellScript(ctx.directoryPath, 'setup-storage', {
    script: "#!/bin/bash\necho 'setup-storage: no mount' >&2; exit 1",
  });

  createStubShellScript(ctx.directoryPath, 'setup-net');
  createStubShellScript(ctx.directoryPath, 'tailscale-up');
  createStubImpd(ctx.directoryPath, { networkEnv: ['IMP_SUBNET=10.66.0.0/16'] });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'setup-storage: no mount\n' });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'impd --network-env',
    'setup-cgroups ',
    'setup-storage ',
    '',
  ]);
});

test('it starts impd without the tailnet when tailscale-up fails', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-cgroups');
  createStubShellScript(ctx.directoryPath, 'setup-storage');
  createStubShellScript(ctx.directoryPath, 'setup-net');
  createStubShellScript(ctx.directoryPath, 'tailscale-up', { script: '#!/bin/bash\nexit 1' });

  createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    recordEnv: ['IMP_TAILSCALE_NODE'],
  });

  // a socket left from an earlier run must not mark the node as up
  const listener = Bun.listen({
    unix: join(ctx.directoryPath, 'tailscaled.sock'),
    socket: { data: () => {} },
  });

  onTestFinished(() => {
    listener.stop(true);
  });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
      IMP_TAILSCALE_SOCKET: join(ctx.directoryPath, 'tailscaled.sock'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: 'entrypoint: tailscale-up failed; continuing without the tailnet\n',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toEndWith(
    'impd \n  IMP_TAILSCALE_NODE=\n',
  );
});

test('it tells impd it is on the tailnet when tailscale-up leaves a tailscaled socket', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-cgroups');
  createStubShellScript(ctx.directoryPath, 'setup-storage');
  createStubShellScript(ctx.directoryPath, 'setup-net');
  createStubShellScript(ctx.directoryPath, 'tailscale-up');

  createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    recordEnv: ['IMP_TAILSCALE_NODE'],
  });

  const listener = Bun.listen({
    unix: join(ctx.directoryPath, 'tailscaled.sock'),
    socket: { data: () => {} },
  });

  onTestFinished(() => {
    listener.stop(true);
  });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
      IMP_TAILSCALE_SOCKET: join(ctx.directoryPath, 'tailscaled.sock'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toEndWith(
    'impd \n  IMP_TAILSCALE_NODE=1\n',
  );
});

test('it restarts impd a second after it exits on its own', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-cgroups');
  createStubShellScript(ctx.directoryPath, 'setup-storage');
  createStubShellScript(ctx.directoryPath, 'setup-net');
  createStubShellScript(ctx.directoryPath, 'tailscale-up');
  createStubBin(ctx.directoryPath, 'sleep');
  createStubImpd(ctx.directoryPath, { networkEnv: ['IMP_SUBNET=10.66.0.0/16'], exitCodes: [7] });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: 'entrypoint: impd exited with 7; restarting in 1s\n',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toEndWith('impd \nsleep 1\nimpd \n');
});

test('it stops the running impd and exits 0 on SIGTERM', async () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-cgroups');
  createStubShellScript(ctx.directoryPath, 'setup-storage');
  createStubShellScript(ctx.directoryPath, 'setup-net');
  createStubShellScript(ctx.directoryPath, 'tailscale-up');

  const impd = createStubImpd(ctx.directoryPath, {
    networkEnv: ['IMP_SUBNET=10.66.0.0/16'],
    lastRun: 'wait-for-term',
  });

  const entrypoint = Bun.spawn(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    entrypoint.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(impd.probeRunning()).toBeTrue();
  });

  entrypoint.kill('SIGTERM');

  const exitCode = await entrypoint.exited;

  const stderr = await new Response(entrypoint.stderr).text();

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(impd.probeTerminated()).toBeTrue();
  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toEndWith('impd \n');
});

test('it exports the lines of IMP_ENV_FILE over the image’s env before it picks impd', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'impd', {
    script: "#!/bin/bash\necho 'impd: stop here' >&2; exit 3",
  });

  symlinkSync(
    new URL('scripts/load-env-file.sh', import.meta.url).pathname,
    join(ctx.directoryPath, 'load-env-file.sh'),
  );

  writeFileSync(join(ctx.directoryPath, 'env'), `IMP_DAEMON=${join(ctx.directoryPath, 'impd')}\n`);

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: '/usr/local/bin/impd',
      IMP_ENV_FILE: join(ctx.directoryPath, 'env'),
    },
  });

  expect(result.exitCode).toBe(3);
  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('impd --network-env\n');
});

test('it stops the container before impd when IMP_ENV_FILE is missing', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'impd');

  symlinkSync(
    new URL('scripts/load-env-file.sh', import.meta.url).pathname,
    join(ctx.directoryPath, 'load-env-file.sh'),
  );

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.directoryPath,
      IMP_DAEMON: join(ctx.directoryPath, 'impd'),
      IMP_ENV_FILE: join(ctx.directoryPath, 'none'),
    },
  });

  expect(result.exitCode).toBe(1);
  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('');
});
