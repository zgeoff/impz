import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubBin } from '../scripts/test-utils/create-stub-bin';

// Each test points IMP_LIB at the stub directory, so the setup scripts the
// entrypoint runs are stubs that record into the same calls file as impd. A
// stub impd that ends the supervisor sends SIGTERM to the entrypoint, its parent.
function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-entrypoint-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    bin: join(directory, 'bin'),
    calls: join(directory, 'calls'),
    script: new URL('entrypoint', import.meta.url).pathname,
  };
}

test('it runs the repo impd source under bun when IMP_DAEMON is unset', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'bun', 'exit 1');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_LIB: ctx.bin },
  });

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.calls, 'utf8')).toBe(
    'bun /src/packages/daemon/src/main.ts --network-env\n',
  );
});

test('it runs a .ts IMP_DAEMON under bun', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'bun', 'exit 1');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: '/opt/impd/main.ts',
    },
  });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.calls, 'utf8')).toBe('bun /opt/impd/main.ts --network-env\n');
});

test('it stops the container with impd’s exit code when the compiled impd refuses a setting', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'bun');
  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');
  createStubBin(ctx.directoryPath, 'impd', "echo 'impd: IMP_SUBNET is not a CIDR' >&2; exit 3");

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
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

  expect(readFileSync(ctx.calls, 'utf8')).toBe('impd --network-env\n');
});

test('it exports impd’s network settings, runs each setup script in order, then impd', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');
  createStubBin(ctx.directoryPath, 'setup-storage.sh');

  createStubBin(
    ctx.directoryPath,
    'setup-net.sh',
    'echo "setup-net sees IMP_SUBNET=$IMP_SUBNET IMP_BROKER_PORT=$IMP_BROKER_PORT" >>"$STUB_CALLS"',
  );

  createStubBin(ctx.directoryPath, 'tailscale-up.sh');

  createStubBin(
    ctx.directoryPath,
    'impd',
    `if [ "$1" = --network-env ]; then printf 'IMP_SUBNET=10.66.0.0/16\\nIMP_BROKER_PORT=7081\\n'; exit 0; fi
echo "impd sees IMP_TAILSCALE_NODE=\${IMP_TAILSCALE_NODE:-}" >>"$STUB_CALLS"
kill -TERM "$PPID"`,
  );

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
      IMP_TAILSCALE_SOCKET: join(ctx.directoryPath, 'tailscaled.sock'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'impd --network-env',
    'setup-cgroups.sh ',
    'setup-storage.sh ',
    'setup-net.sh ',
    'setup-net sees IMP_SUBNET=10.66.0.0/16 IMP_BROKER_PORT=7081',
    'tailscale-up.sh ',
    'impd ',
    'impd sees IMP_TAILSCALE_NODE=',
    '',
  ]);
});

test('it stops the container before impd when a setup script fails', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');

  createStubBin(
    ctx.directoryPath,
    'setup-storage.sh',
    "echo 'setup-storage: no mount' >&2; exit 1",
  );

  createStubBin(ctx.directoryPath, 'setup-net.sh');
  createStubBin(ctx.directoryPath, 'tailscale-up.sh');

  createStubBin(
    ctx.directoryPath,
    'impd',
    `if [ "$1" = --network-env ]; then echo IMP_SUBNET=10.66.0.0/16; exit 0; fi
kill -TERM "$PPID"`,
  );

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'setup-storage: no mount\n' });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'impd --network-env',
    'setup-cgroups.sh ',
    'setup-storage.sh ',
    '',
  ]);
});

test('it starts impd without the tailnet when tailscale-up fails', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');
  createStubBin(ctx.directoryPath, 'setup-storage.sh');
  createStubBin(ctx.directoryPath, 'setup-net.sh');
  createStubBin(ctx.directoryPath, 'tailscale-up.sh', 'exit 1');

  createStubBin(
    ctx.directoryPath,
    'impd',
    `if [ "$1" = --network-env ]; then echo IMP_SUBNET=10.66.0.0/16; exit 0; fi
echo "impd sees IMP_TAILSCALE_NODE=\${IMP_TAILSCALE_NODE:-}" >>"$STUB_CALLS"
kill -TERM "$PPID"`,
  );

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
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
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

  expect(readFileSync(ctx.calls, 'utf8')).toEndWith('impd \nimpd sees IMP_TAILSCALE_NODE=\n');
});

test('it tells impd it is on the tailnet when tailscale-up leaves a tailscaled socket', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');
  createStubBin(ctx.directoryPath, 'setup-storage.sh');
  createStubBin(ctx.directoryPath, 'setup-net.sh');
  createStubBin(ctx.directoryPath, 'tailscale-up.sh');

  createStubBin(
    ctx.directoryPath,
    'impd',
    `if [ "$1" = --network-env ]; then echo IMP_SUBNET=10.66.0.0/16; exit 0; fi
echo "impd sees IMP_TAILSCALE_NODE=\${IMP_TAILSCALE_NODE:-}" >>"$STUB_CALLS"
kill -TERM "$PPID"`,
  );

  const listener = Bun.listen({
    unix: join(ctx.directoryPath, 'tailscaled.sock'),
    socket: { data: () => {} },
  });

  onTestFinished(() => {
    listener.stop(true);
  });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
      IMP_TAILSCALE_SOCKET: join(ctx.directoryPath, 'tailscaled.sock'),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.calls, 'utf8')).toEndWith('impd \nimpd sees IMP_TAILSCALE_NODE=1\n');
});

test('it restarts impd a second after it exits on its own', () => {
  const ctx = setupTest();
  const ranOnce = formatShellWord(join(ctx.directoryPath, 'ran-once'));

  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');
  createStubBin(ctx.directoryPath, 'setup-storage.sh');
  createStubBin(ctx.directoryPath, 'setup-net.sh');
  createStubBin(ctx.directoryPath, 'tailscale-up.sh');
  createStubBin(ctx.directoryPath, 'sleep');

  createStubBin(
    ctx.directoryPath,
    'impd',
    `if [ "$1" = --network-env ]; then echo IMP_SUBNET=10.66.0.0/16; exit 0; fi
if [ ! -e ${ranOnce} ]; then touch ${ranOnce}; exit 7; fi
kill -TERM "$PPID"`,
  );

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
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

  expect(readFileSync(ctx.calls, 'utf8')).toEndWith('impd \nsleep 1\nimpd \n');
});

test('it stops the running impd and exits 0 on SIGTERM', async () => {
  const ctx = setupTest();
  const running = join(ctx.directoryPath, 'running');

  createStubBin(ctx.directoryPath, 'setup-cgroups.sh');
  createStubBin(ctx.directoryPath, 'setup-storage.sh');
  createStubBin(ctx.directoryPath, 'setup-net.sh');
  createStubBin(ctx.directoryPath, 'tailscale-up.sh');

  // the wait is bounded, so a stub that misses its signal still ends
  createStubBin(
    ctx.directoryPath,
    'impd',
    `if [ "$1" = --network-env ]; then echo IMP_SUBNET=10.66.0.0/16; exit 0; fi
trap 'echo "impd got TERM" >>"$STUB_CALLS"; exit 0' TERM
touch ${formatShellWord(running)}
for _ in $(seq 300); do command -p sleep 0.1; done`,
  );

  const entrypoint = Bun.spawn(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    entrypoint.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(existsSync(running)).toBeTrue();
  });

  entrypoint.kill('SIGTERM');

  const exitCode = await entrypoint.exited;

  const stderr = await new Response(entrypoint.stderr).text();

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(readFileSync(ctx.calls, 'utf8')).toEndWith('impd \nimpd got TERM\n');
});

test('it exports the lines of IMP_ENV_FILE over the image’s env before it picks impd', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'impd', "echo 'impd: stop here' >&2; exit 3");

  symlinkSync(
    new URL('scripts/load-env-file.sh', import.meta.url).pathname,
    join(ctx.bin, 'load-env-file.sh'),
  );

  writeFileSync(join(ctx.directoryPath, 'env'), `IMP_DAEMON=${join(ctx.bin, 'impd')}\n`);

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: '/usr/local/bin/impd',
      IMP_ENV_FILE: join(ctx.directoryPath, 'env'),
    },
  });

  expect(result.exitCode).toBe(3);
  expect(readFileSync(ctx.calls, 'utf8')).toBe('impd --network-env\n');
});

test('it stops the container before impd when IMP_ENV_FILE is missing', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'impd');

  symlinkSync(
    new URL('scripts/load-env-file.sh', import.meta.url).pathname,
    join(ctx.bin, 'load-env-file.sh'),
  );

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_LIB: ctx.bin,
      IMP_DAEMON: join(ctx.bin, 'impd'),
      IMP_ENV_FILE: join(ctx.directoryPath, 'none'),
    },
  });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
});
