import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubSlowCommand } from './create-stub-slow-command';
import { waitFor } from './wait-for';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'stub-slow-command-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it holds a started call until the release file exists, then logs it as finished', async () => {
  const ctx = setupTest();
  const stub = createStubSlowCommand(ctx.directory, 'docker');
  const child = Bun.spawn([join(stub.bin, 'docker'), 'image', 'inspect', 'imp-host:test']);

  onTestFinished(async () => {
    child.kill('SIGKILL');

    await child.exited;
  });

  await waitFor(
    () => {
      if (readFileSync(stub.log, 'utf8') === '') {
        throw new Error('the call has not started');
      }
    },
    { label: 'the started line' },
  );

  const held = readFileSync(stub.log, 'utf8');

  writeFileSync(stub.release, '');

  const exitCode = await child.exited;

  expect(held).toBe('docker image inspect imp-host:test started\n');
  expect(exitCode).toBe(0);

  expect(readFileSync(stub.log, 'utf8')).toBe(
    'docker image inspect imp-host:test started\ndocker image inspect imp-host:test finished\n',
  );
});

test('it ends a held call once its log is gone', async () => {
  const ctx = setupTest();
  const stub = createStubSlowCommand(ctx.directory, 'docker');
  const child = Bun.spawn([join(stub.bin, 'docker'), 'image', 'inspect', 'imp-host:test']);

  onTestFinished(async () => {
    child.kill('SIGKILL');

    await child.exited;
  });

  await waitFor(
    () => {
      if (readFileSync(stub.log, 'utf8') === '') {
        throw new Error('the call has not started');
      }
    },
    { label: 'the started line' },
  );

  rmSync(stub.log);

  const exitCode = await child.exited;

  expect(exitCode).toBe(0);
});

test('it runs a call straight through when the release file already exists', async () => {
  const ctx = setupTest();
  const stub = createStubSlowCommand(ctx.directory, 'docker');

  writeFileSync(stub.release, '');

  const exitCode = await Bun.spawn([join(stub.bin, 'docker'), 'save', 'imp-host:test']).exited;

  expect(exitCode).toBe(0);

  expect(readFileSync(stub.log, 'utf8')).toBe(
    'docker save imp-host:test started\ndocker save imp-host:test finished\n',
  );
});
