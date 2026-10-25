import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { createFilesTar } from '../../../../testing/imps/create-files-tar';
import { createStubOciFetch } from '../../../../testing/imps/create-stub-oci-fetch';
import { buildStubClock } from '../../../../testing/platform/build-stub-clock';
import { runStreamed } from '../../../platform/process/run-streamed';
import { ImageLimitError } from '../build/image-limit-error';
import { startTarProcess } from './start-tar-process';
import { writeOciTree } from './write-oci-tree';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'write-oci-tree-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const root = join(directory, 'root');

  mkdirSync(root);

  return { directoryPath: directory, root };
}

test('it unpacks the tree oci-fetch exports into the root', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { dockerd: 'builder\n' }),
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);

  await writeOciTree({
    ref: 'registry.test/builder@sha256:1',
    root: ctx.root,
    limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
    signal: new AbortController().signal,
    grow: () => Promise.resolve(),
    runStreamed,
  });

  expect(readFileSync(join(ctx.root, 'dockerd'), 'utf8')).toBe('builder\n');
});

test("it unpacks through the given tar starter with tar's unpack and listing flags", async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { dockerd: 'builder\n' }),
      },
    ],
  });

  const startTar = mock(startTarProcess);

  updateEnv('PATH', ociFetch.path);

  await writeOciTree({
    ref: 'registry.test/builder@sha256:1',
    root: ctx.root,
    limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
    signal: new AbortController().signal,
    grow: () => Promise.resolve(),
    runStreamed,
    startTar,
  });

  expect(startTar).toHaveBeenCalledExactlyOnceWith([
    'tar',
    '--numeric-owner',
    '--xattrs',
    '--xattrs-include=security.capability',
    '--xattrs-include=user.*',
    '-xpf',
    '-',
    '-vv',
    '--quoting-style=escape',
    '-C',
    ctx.root,
  ]);
});

test('it holds disk ahead of the tree in 256 MiB steps', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { dockerd: 'builder\n' }),
      },
    ],
  });

  const holds: number[] = [];

  updateEnv('PATH', ociFetch.path);

  await writeOciTree({
    ref: 'registry.test/builder@sha256:1',
    root: ctx.root,
    limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
    signal: new AbortController().signal,
    grow: (totalBytes) => {
      holds.push(totalBytes);

      return Promise.resolve();
    },
    runStreamed,
  });

  expect(holds).toStrictEqual([256 * 1024 ** 2]);
});

test('it grows the hold with the written bytes that the given tree counter reads', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { dockerd: 'builder\n' }),
      },
    ],
  });

  const grows: number[][] = [];

  updateEnv('PATH', ociFetch.path);

  await writeOciTree({
    ref: 'registry.test/builder@sha256:1',
    root: ctx.root,
    limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
    signal: new AbortController().signal,
    grow: (totalBytes, writtenBytes) => {
      grows.push([totalBytes, writtenBytes]);

      return Promise.resolve();
    },
    runStreamed,
    countTreeBytes: () => Promise.resolve(4096),
  });

  expect(grows).toStrictEqual([[256 * 1024 ** 2, 4096]]);
});

test('it fails with the stderr of an export that fails', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({ directory: ctx.directoryPath });

  updateEnv('PATH', ociFetch.path);

  expect(
    writeOciTree({
      ref: 'registry.test/builder@sha256:1',
      root: ctx.root,
      limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
      signal: new AbortController().signal,
      grow: () => Promise.resolve(),
      runStreamed,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'oci-fetch export registry.test/builder@sha256:1: oci-fetch: fetch registry.test/builder@sha256:1: MANIFEST_UNKNOWN: manifest unknown',
  );
});

test('it stops a stalled export and fails the write when the signal aborts', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { dockerd: 'builder\n' }),
        export: 'stall',
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);

  const stop = new AbortController();

  const writing = writeOciTree({
    ref: 'registry.test/builder@sha256:1',
    root: ctx.root,
    limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
    signal: stop.signal,
    grow: () => Promise.resolve(),
    runStreamed,
  });

  await waitFor(() => {
    expect(ociFetch.readStalledPIDs()).toHaveLength(1);
  });

  const [pid] = ociFetch.readStalledPIDs();

  invariant(pid !== undefined);

  stop.abort(new Error('the build was cancelled'));

  const failure = await writing.then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toStrictEqual(new Error('the build was cancelled'));
  expect(() => process.kill(pid, 0)).toThrow();
});

test('it ends an export that sends nothing for its idle limit on the given timer', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { dockerd: 'builder\n' }),
        export: 'stall',
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);

  const timers = buildStubClock();

  const writing = writeOciTree({
    ref: 'registry.test/builder@sha256:1',
    root: ctx.root,
    limits: { maxBytes: 1024 ** 3, maxFiles: 100 },
    signal: new AbortController().signal,
    grow: () => Promise.resolve(),
    runStreamed,
    startTimer: timers.startTimer,
  });

  await waitFor(() => {
    expect(ociFetch.readStalledPIDs()).toHaveLength(1);
  });

  timers.firePending();

  expect(writing).rejects.toThrowWithMessage(
    Error,
    'oci-fetch export registry.test/builder@sha256:1 sent nothing in 120 s',
  );
});

test('it refuses a tree of more entries than the file cap', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: createFilesTar(ctx.directoryPath, { one: '1\n', two: '2\n', three: '3\n' }),
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);

  expect(
    writeOciTree({
      ref: 'registry.test/builder@sha256:1',
      root: ctx.root,
      limits: { maxBytes: 1024 ** 3, maxFiles: 2 },
      signal: new AbortController().signal,
      grow: () => Promise.resolve(),
      runStreamed,
    }),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 2 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );
});
