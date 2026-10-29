import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
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

  expect(handler.readStarts()).toStrictEqual([
    { args: ['--socket', socket], served: 'guest pages' },
  ]);
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
    { args: [`--socket=${socket}`, '--uid', '100', '--gid', '100'], served: '' },
  ]);
});

test('it exits at its first connection in crash mode', async () => {
  const ctx = setupTest();
  const handler = createStubUffdHandler(ctx.directoryPath, 'crash');
  const socket = join(ctx.directoryPath, 'uffd.sock');
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');

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

  const peer = connect(socket);

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
