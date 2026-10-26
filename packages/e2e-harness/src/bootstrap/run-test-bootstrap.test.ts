import { expect, mock, test } from 'bun:test';
import { BOOTSTRAP_USAGE } from './parse-bootstrap-args';
import { runTestBootstrap } from './run-test-bootstrap';
import { wireBootstrapIO } from './wire-bootstrap-io';

function setupTest() {
  const io = {
    ...wireBootstrapIO(),
    writeStdout: mock(),
    writeStderr: mock(),
    createWorkDirectory: mock(() => '/nonexistent/test-bootstrap'),
    onSignal: mock(),
  };

  return { io };
}

test('it refuses a run with no image and makes no work directory', async () => {
  const ctx = setupTest();

  const exitCode = await runTestBootstrap({ argv: [], root: '/repo', runID: 4242, io: ctx.io });

  expect(exitCode).toBe(2);

  expect(ctx.io.writeStderr).toHaveBeenCalledExactlyOnceWith(
    'test-bootstrap: give --image REF or --stub\n',
  );

  expect(ctx.io.createWorkDirectory).not.toHaveBeenCalled();
});

test('it refuses --zfs when the host has no zfs module loaded', async () => {
  const ctx = setupTest();
  const probeReadable = mock(() => false);

  const exitCode = await runTestBootstrap({
    argv: ['--stub', '--zfs'],
    root: '/repo',
    runID: 4242,
    io: { ...ctx.io, probeReadable },
  });

  expect(exitCode).toBe(2);
  expect(probeReadable).toHaveBeenCalledExactlyOnceWith('/sys/module/zfs/version');

  expect(ctx.io.writeStderr).toHaveBeenCalledExactlyOnceWith(
    'test-bootstrap: --zfs needs the zfs module loaded on this host\n',
  );

  expect(ctx.io.createWorkDirectory).not.toHaveBeenCalled();
});

test('it prints the usage for --help and exits 0', async () => {
  const ctx = setupTest();

  const exitCode = await runTestBootstrap({
    argv: ['--help'],
    root: '/repo',
    runID: 4242,
    io: ctx.io,
  });

  expect(exitCode).toBe(0);
  expect(ctx.io.writeStdout).toHaveBeenCalledExactlyOnceWith(BOOTSTRAP_USAGE);
});
