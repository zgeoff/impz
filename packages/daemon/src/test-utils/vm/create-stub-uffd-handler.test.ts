import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { createStubUffdHandler } from './create-stub-uffd-handler';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'stub-uffd-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it serves on its socket and records its arguments and the memory file it was given', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath);
  const socket = join(ctx.directoryPath, 'uffd.sock');
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, 'guest pages');

  const memFd = openSync(memFile, 'r');

  const child = Bun.spawn([handler.path, '--socket', socket], {
    stdio: ['ignore', 'ignore', 'inherit', memFd],
  });

  closeSync(memFd);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(existsSync(socket)).toBeTrue();
  });

  expect(handler.readStarts()).toStrictEqual([{ options: { socket }, served: 'guest pages' }]);
});

test('it serves on a socket given in the --socket=<path> form', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath);
  const socket = join(ctx.directoryPath, 'uffd.sock');
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');

  const memFd = openSync(memFile, 'r');

  const child = Bun.spawn([handler.path, `--socket=${socket}`, '--uid', '100', '--gid', '100'], {
    stdio: ['ignore', 'ignore', 'inherit', memFd],
  });

  closeSync(memFd);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(existsSync(socket)).toBeTrue();
  });

  expect(handler.readStarts()).toStrictEqual([
    { options: { socket, uid: '100', gid: '100' }, served: '' },
  ]);
});

test('it exits at its first connection in crash mode', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath, 'crash');
  const socket = join(ctx.directoryPath, 'uffd.sock');
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');

  const memFd = openSync(memFile, 'r');

  const child = Bun.spawn([handler.path, `--socket=${socket}`], {
    stdio: ['ignore', 'ignore', 'inherit', memFd],
  });

  closeSync(memFd);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(existsSync(socket)).toBeTrue();
  });

  const peer = connect(socket);

  // the handler exits at the connection, so the peer can see ECONNRESET, which an unheard socket
  // error turns into a failed test
  peer.on('error', () => {});

  onTestFinished(() => {
    peer.destroy();
  });

  expect(child.exited).resolves.toBe(2);
});

test('it exits before it binds its socket in refuse mode', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath, 'refuse');
  const socket = join(ctx.directoryPath, 'uffd.sock');

  const child = Bun.spawn([handler.path, '--socket', socket], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const exitCode = await child.exited;

  const stderr = await new Response(child.stderr).text();

  expect(exitCode).toBe(1);
  expect(stderr).toBe('not enough 2 MiB pages\n');
  expect(existsSync(socket)).toBeFalse();
  expect(handler.readStarts()).toStrictEqual([]);
});

test('it answers a count of the data blocks with one block until a test sets the answer', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  const child = Bun.spawn([handler.path, '--count-data', memFile], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const exitCode = await child.exited;

  const stdout = await new Response(child.stdout).text();

  expect({ exitCode, stdout }).toStrictEqual({ exitCode: 0, stdout: '{"blocks":1}\n' });

  expect(handler.readWarmRuns()).toStrictEqual([
    { mode: '--count-data', memFile, pid: expect.any(Number) },
  ]);
});

test('it answers a warm with the blocks a test sets', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath);

  handler.answerWarm({ blocks: 40 });

  const child = Bun.spawn([handler.path, '--warm', join(ctx.directoryPath, 'mem')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const exitCode = await child.exited;

  const stdout = await new Response(child.stdout).text();

  expect({ exitCode, stdout }).toStrictEqual({ exitCode: 0, stdout: '{"blocks":40}\n' });
});

test('it runs a warm until it is killed when a test sets it to hang', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath);

  handler.answerWarm({ blocks: 40, hangs: true });

  const child = Bun.spawn([handler.path, '--warm', join(ctx.directoryPath, 'mem')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(handler.readWarmRuns()).toHaveLength(1);
  });

  child.kill('SIGTERM');

  expect(child.exited).resolves.toBe(143);
});
