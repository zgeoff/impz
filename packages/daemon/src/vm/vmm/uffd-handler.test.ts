import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubUffdHandler } from '../../../testing/vm/create-stub-uffd-handler';
import { stopPid } from '../../platform/process/proc';
import { buildImpPaths } from '../storage/data-layout';
import { probeProcessAlive } from './firecracker-process';
import {
  buildServedFilePath,
  explainUffdFailure,
  readHandlerState,
  requireHandlerBin,
  startUffdHandler,
  stopUffdHandler,
} from './uffd-handler';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-uffd-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const createImpDir = (impId: string) => {
    const paths = buildImpPaths(directory, impId);

    mkdirSync(paths.runDir, { recursive: true });

    return paths;
  };

  return { directoryPath: directory, createImpDir };
}

test('#startUffdHandler starts the handler on the imp socket with the memory file as descriptor 3', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, 'guest pages');

  const pid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile,
    jail: null,
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(pid);
  });

  expect(handler.readStarts()).toStrictEqual([
    { args: ['--socket', paths.uffdSocket], served: 'guest pages' },
  ]);

  expect(readFileSync(paths.uffdPidFile, 'utf8')).toBe(`${String(pid)}\n`);
  expect(readHandlerState(paths)).toStrictEqual({ state: 'alive', pid });
});

test('#startUffdHandler hands a jailed imp handler the jail user', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');

  const pid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile,
    jail: { uid: 900_001, gid: 900_002 },
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(pid);
  });

  expect(handler.readStarts()).toStrictEqual([
    {
      args: ['--socket', paths.uffdSocket, '--uid', '900001', '--gid', '900002'],
      served: '',
    },
  ]);
});

test('#startUffdHandler refuses a handler that exits before its socket is up, with its log', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath, 'refuse');
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');

  expect(
    startUffdHandler({ handlerBin: handler.path, paths, memFile, jail: null, cgroup: null }),
  ).rejects.toThrowWithMessage(
    Error,
    /the page handler did not open its socket \(exit 1\): .*not enough 2 MiB pages/su,
  );
});

test('#startUffdHandler removes the files a handler of an earlier run left', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');
  writeFileSync(paths.uffdSocket, 'stale');

  const pid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile,
    jail: null,
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(pid);
  });

  expect(readHandlerState(paths)).toStrictEqual({ state: 'alive', pid });
});

test('#readHandlerState reads no handler for an imp with no handler pid file', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  expect(readHandlerState(paths)).toStrictEqual({ state: 'none' });
});

test('#readHandlerState reads a handler whose pid is gone as gone', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const procRoot = join(ctx.directoryPath, 'proc');

  mkdirSync(procRoot);
  writeFileSync(paths.uffdPidFile, '4242\n');

  expect(readHandlerState(paths, procRoot)).toStrictEqual({ state: 'gone', pid: 4242 });
});

test('#buildServedFilePath reads the memory file a handler serves after its name is gone', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, 'template pages');

  const pid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile,
    jail: null,
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(pid);
  });

  rmSync(memFile);

  expect(readFileSync(buildServedFilePath(pid), 'utf8')).toBe('template pages');
});

test('#stopUffdHandler stops the handler of an imp', async () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const handler = createStubUffdHandler(ctx.directoryPath);
  const memFile = join(ctx.directoryPath, 'mem');

  writeFileSync(memFile, '');

  const pid = await startUffdHandler({
    handlerBin: handler.path,
    paths,
    memFile,
    jail: null,
    cgroup: null,
  });

  onTestFinished(() => {
    stopPid(pid);
  });

  stopUffdHandler(paths);

  await waitFor(() => {
    expect(probeProcessAlive(pid, paths.uffdSocket)).toBeFalse();
  });
});

test('#explainUffdFailure names the page handler of an imp whose handler is gone', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');
  const procRoot = join(ctx.directoryPath, 'proc');

  mkdirSync(procRoot);
  writeFileSync(paths.uffdPidFile, '4242\n');

  expect(explainUffdFailure(paths, procRoot, 'socket closed')).toBe(
    'its page handler exited (socket closed)',
  );
});

test('#explainUffdFailure keeps the reason of an imp with no page handler', () => {
  const ctx = setupTest();
  const paths = ctx.createImpDir('vm');

  expect(explainUffdFailure(paths, '/proc', 'socket closed')).toBe('socket closed');
});

test('#requireHandlerBin refuses a 2M restore with huge pages off', () => {
  expect(() => requireHandlerBin(null)).toThrowWithMessage(
    Error,
    'a 2 MiB snapshot restores only through the page handler, and IMP_HUGE_PAGES is off',
  );
});

test('#requireHandlerBin answers the handler binary it is given', () => {
  expect(requireHandlerBin('/usr/local/bin/uffd-handler')).toBe('/usr/local/bin/uffd-handler');
});
