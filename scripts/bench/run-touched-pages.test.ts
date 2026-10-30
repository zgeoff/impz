import { expect, mock, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { buildMockSystemInfo } from '@impz/api/test-utils/build-mock-system-info';
import { ORPCError } from '@impz/client';
import type { CommandResult } from '@impz/e2e-harness/instance';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import * as z from 'zod';
import { runTouchedPages } from './run-touched-pages';

test('it reports the pages a cold and a woken sleep touched, then removes its imp and copy', async () => {
  const shownImp = buildStubAnswerQueue([
    () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
    () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
  ]);

  const impzRuns: Readonly<Record<string, CommandResult>> = {
    'exec touched-pages -- true': { exitCode: 0, stdout: '', stderr: '' },
    'exec touched-pages -- sh -c dd if=/dev/urandom of=/dev/shm/written bs=1M count=128': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'sleep touched-pages': { exitCode: 0, stdout: '', stderr: '' },
    'wake touched-pages': { exitCode: 0, stdout: '', stderr: '' },
    'exec touched-pages -- sh -c sha256sum /dev/shm/written && sleep 5': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
  };

  const statuses = buildStubAnswerQueue<CommandResult>([
    { exitCode: 0, stdout: 'Name:\tfirecracker\nHugetlbPages:\t  299008 kB\n', stderr: '' },
    { exitCode: 0, stdout: 'Name:\tfirecracker\nHugetlbPages:\t  165888 kB\n', stderr: '' },
  ]);

  const memBlocks = buildStubAnswerQueue<CommandResult>([
    { exitCode: 0, stdout: '614400\n', stderr: '' },
    { exitCode: 0, stdout: '204800\n', stderr: '' },
  ]);

  const containerRuns: Readonly<Record<string, () => CommandResult>> = {
    'cat /var/lib/imp/imps/imp_1/run/pid': () => ({ exitCode: 0, stdout: '4242\n', stderr: '' }),
    'cat /proc/4242/status': () => statuses.next(),
    'stat -c %b /var/lib/imp/imps/imp_1/snapshot/mem': () => memBlocks.next(),
    'cat /var/lib/imp/imps/imp_1/run/uffd.pid': () => ({
      exitCode: 0,
      stdout: '4343\n',
      stderr: '',
    }),
    'cp --sparse=always /proc/4343/fd/3 /var/lib/imp/touched-pages-base': () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    'bun /src/scripts/bench/count-changed-pages.ts /var/lib/imp/touched-pages-base /var/lib/imp/imps/imp_1/snapshot/mem':
      () => ({ exitCode: 0, stdout: '{"changedMib":130,"changedHugeMib":136}\n', stderr: '' }),
    'rm -f /var/lib/imp/touched-pages-base': () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };

  const runImpz = mock((args: readonly string[]) =>
    Promise.resolve(
      impzRuns[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const runInContainer = mock((argv: readonly string[]) =>
    Promise.resolve(
      containerRuns[argv.join(' ')]?.() ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const create = mock(() => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })));
  const destroy = mock(() => Promise.resolve({}));

  const measured = await runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: { get: () => shownImp.next()(), create, destroy },
      },
      runImpz,
      runInContainer,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).toStrictEqual({
    memory: '1g',
    writeMib: 128,
    coldSleep: { touchedMib: 292, memFileMib: 300 },
    wokenSleep: { touchedMib: 162, changedMib: 130, changedHugeMib: 136, memFileMib: 100 },
  });

  expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'touched-pages', memoryMib: 1024 });

  expect(runImpz.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'exec touched-pages -- true',
    'exec touched-pages -- sh -c dd if=/dev/urandom of=/dev/shm/written bs=1M count=128',
    'sleep touched-pages',
    'wake touched-pages',
    'exec touched-pages -- sh -c sha256sum /dev/shm/written && sleep 5',
    'sleep touched-pages',
  ]);

  expect(runInContainer).toHaveBeenLastCalledWith(['rm', '-f', '/var/lib/imp/touched-pages-base']);
  expect(destroy).toHaveBeenCalledExactlyOnceWith({ name: 'touched-pages' });
});

test('it looks for an imp of its name only once impd has its default image', async () => {
  const infos = buildStubAnswerQueue([
    buildMockSystemInfo({ defaults: { image: null } }),
    buildMockSystemInfo({ defaults: { image: 'base' } }),
  ]);

  const info = mock(() => Promise.resolve(infos.next()));
  const get = mock(() => Promise.resolve(buildMockImp({ name: 'touched-pages' })));

  await runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: { info },
        imps: {
          get,
          create: () => Promise.reject(new Error('no create was expected')),
          destroy: () => Promise.resolve({}),
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 127, stdout: '', stderr: 'no such command' }),
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  ).catch(() => null);

  expect(info).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledAfter(info);
});

test('it removes the imp a failed create left behind, then releases the lock', () => {
  const destroy = mock(() => Promise.resolve({}));
  const release = mock(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () =>
            Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
          create: () =>
            Promise.reject(
              new ORPCError('INTERNAL_SERVER_ERROR', { message: 'the disk clone failed' }),
            ),
          destroy,
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: the create of touched-pages failed',
  );

  expect(destroy).toHaveBeenCalledExactlyOnceWith({ name: 'touched-pages' });
  expect(release).toHaveBeenCalledAfter(destroy);
});

test('it leaves an imp of its name that it found before the create', () => {
  const create = mock(() => Promise.resolve(buildMockImp({ name: 'touched-pages' })));
  const destroy = mock(() => Promise.resolve({}));
  const runInContainer = mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));
  const release = mock(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => Promise.resolve(buildMockImp({ id: 'imp_kept', name: 'touched-pages' })),
          create,
          destroy,
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: touched-pages already exists, so this run leaves it',
  );

  expect(create).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(runInContainer).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

test('it leaves an imp of its name that appeared during the run, when impd refuses the create', () => {
  const destroy = mock(() => Promise.resolve({}));
  const runInContainer = mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () =>
            Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
          create: () =>
            Promise.reject(
              new ORPCError('CONFLICT', { message: 'an imp named touched-pages already exists' }),
            ),
          destroy,
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: touched-pages appeared during the run, so this run leaves it',
  );

  expect(destroy).not.toHaveBeenCalled();
  expect(runInContainer).not.toHaveBeenCalled();
});

test('it runs nothing while another bench holds the dev instance', () => {
  const info = mock(() => Promise.resolve(buildMockSystemInfo()));

  const measured = runTouchedPages(
    {
      lockDev: () => {
        throw new Error(
          'process 4242 holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)',
        );
      },
      client: {
        system: { info },
        imps: {
          get: () => Promise.resolve(buildMockImp()),
          create: () => Promise.resolve(buildMockImp()),
          destroy: () => Promise.resolve({}),
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'process 4242 holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)',
  );

  expect(info).not.toHaveBeenCalled();
});

test('it reports a cleanup that failed after a failed create, and keeps the create error', () => {
  const onStderr = mock<(text: string) => void>(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () =>
            Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
          create: () =>
            Promise.reject(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'the boot failed' })),
          destroy: () =>
            Promise.reject(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'the disk is busy' })),
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: the create of touched-pages failed',
  );

  expect(onStderr).toHaveBeenCalledExactlyOnceWith(
    'measure-touched-pages: could not remove touched-pages: the disk is busy',
  );
});

test('it fails with the command error when the guest write fails, and removes its imp and copy', () => {
  const shownImp = buildStubAnswerQueue([
    () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
    () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
  ]);

  const impzRuns: Readonly<Record<string, CommandResult>> = {
    'exec touched-pages -- true': { exitCode: 0, stdout: '', stderr: '' },
    'exec touched-pages -- sh -c dd if=/dev/urandom of=/dev/shm/written bs=1M count=128': {
      exitCode: 1,
      stdout: '',
      stderr: "dd: error writing '/dev/shm/written': No space left on device\n",
    },
  };

  const containerRuns: Readonly<Record<string, CommandResult>> = {
    'rm -f /var/lib/imp/touched-pages-base': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runInContainer = mock((argv: readonly string[]) =>
    Promise.resolve(
      containerRuns[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const destroy = mock(() => Promise.resolve({}));

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => shownImp.next()(),
          create: () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
          destroy,
        },
      },
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      runInContainer,
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    "measure-touched-pages: impz exec touched-pages -- sh -c dd if=/dev/urandom of=/dev/shm/written bs=1M count=128 exited 1: dd: error writing '/dev/shm/written': No space left on device\n",
  );

  expect(runInContainer).toHaveBeenCalledExactlyOnceWith([
    'rm',
    '-f',
    '/var/lib/imp/touched-pages-base',
  ]);

  expect(destroy).toHaveBeenCalledExactlyOnceWith({ name: 'touched-pages' });
});

test('it fails when stat gives no block count for the memory file, and removes its imp', () => {
  const shownImp = buildStubAnswerQueue([
    () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
    () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
  ]);

  const containerRuns: Readonly<Record<string, CommandResult>> = {
    'cat /var/lib/imp/imps/imp_1/run/pid': { exitCode: 0, stdout: '4242\n', stderr: '' },
    'cat /proc/4242/status': { exitCode: 0, stdout: 'HugetlbPages:\t  2048 kB\n', stderr: '' },
    'stat -c %b /var/lib/imp/imps/imp_1/snapshot/mem': {
      exitCode: 0,
      stdout: '?\n',
      stderr: '',
    },
    'rm -f /var/lib/imp/touched-pages-base': { exitCode: 0, stdout: '', stderr: '' },
  };

  const destroy = mock(() => Promise.resolve({}));

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => shownImp.next()(),
          create: () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
          destroy,
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: (argv) =>
        Promise.resolve(
          containerRuns[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    TypeError,
    'measure-touched-pages: stat gave no block count for /var/lib/imp/imps/imp_1/snapshot/mem',
  );

  expect(destroy).toHaveBeenCalledExactlyOnceWith({ name: 'touched-pages' });
});

test('it fails on a changed-page report it cannot read, and removes its imp', () => {
  const shownImp = buildStubAnswerQueue([
    () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
    () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
  ]);

  const containerRuns: Readonly<Record<string, CommandResult>> = {
    'cat /var/lib/imp/imps/imp_1/run/pid': { exitCode: 0, stdout: '4242\n', stderr: '' },
    'cat /proc/4242/status': { exitCode: 0, stdout: 'HugetlbPages:\t  2048 kB\n', stderr: '' },
    'stat -c %b /var/lib/imp/imps/imp_1/snapshot/mem': {
      exitCode: 0,
      stdout: '2048\n',
      stderr: '',
    },
    'cat /var/lib/imp/imps/imp_1/run/uffd.pid': { exitCode: 0, stdout: '4343\n', stderr: '' },
    'cp --sparse=always /proc/4343/fd/3 /var/lib/imp/touched-pages-base': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'bun /src/scripts/bench/count-changed-pages.ts /var/lib/imp/touched-pages-base /var/lib/imp/imps/imp_1/snapshot/mem':
      { exitCode: 0, stdout: '{"changedPages":256}\n', stderr: '' },
    'rm -f /var/lib/imp/touched-pages-base': { exitCode: 0, stdout: '', stderr: '' },
  };

  const destroy = mock(() => Promise.resolve({}));

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => shownImp.next()(),
          create: () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
          destroy,
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: (argv) =>
        Promise.resolve(
          containerRuns[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toBeInstanceOf(z.ZodError);
  expect(destroy).toHaveBeenCalledExactlyOnceWith({ name: 'touched-pages' });
});

test('it fails with the lookup error and creates nothing when impd cannot look up its imp', () => {
  const lookupFailure = new ORPCError('INTERNAL_SERVER_ERROR', { message: 'the database is busy' });

  const create = mock(() => Promise.resolve(buildMockImp({ name: 'touched-pages' })));
  const release = mock(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => Promise.reject(lookupFailure),
          create,
          destroy: () => Promise.resolve({}),
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toBe(lookupFailure);
  expect(create).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

test('it fails a measurement whose cleanup left the base copy behind, and says so', () => {
  const shownImp = buildStubAnswerQueue([
    () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
    () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
  ]);

  const containerRuns: Readonly<Record<string, CommandResult>> = {
    'cat /var/lib/imp/imps/imp_1/run/pid': { exitCode: 0, stdout: '4242\n', stderr: '' },
    'cat /proc/4242/status': { exitCode: 0, stdout: 'HugetlbPages:\t  2048 kB\n', stderr: '' },
    'stat -c %b /var/lib/imp/imps/imp_1/snapshot/mem': {
      exitCode: 0,
      stdout: '2048\n',
      stderr: '',
    },
    'cat /var/lib/imp/imps/imp_1/run/uffd.pid': { exitCode: 0, stdout: '4343\n', stderr: '' },
    'cp --sparse=always /proc/4343/fd/3 /var/lib/imp/touched-pages-base': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'bun /src/scripts/bench/count-changed-pages.ts /var/lib/imp/touched-pages-base /var/lib/imp/imps/imp_1/snapshot/mem':
      { exitCode: 0, stdout: '{"changedMib":1,"changedHugeMib":2}\n', stderr: '' },
    'rm -f /var/lib/imp/touched-pages-base': {
      exitCode: 1,
      stdout: '',
      stderr: "rm: cannot remove '/var/lib/imp/touched-pages-base': Device or resource busy\n",
    },
  };

  const onStderr = mock<(text: string) => void>(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => shownImp.next()(),
          create: () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
          destroy: () => Promise.resolve({}),
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: (argv) =>
        Promise.resolve(
          containerRuns[argv.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr,
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: the cleanup failed, so the dev instance keeps a leftover',
  );

  expect(onStderr).toHaveBeenCalledExactlyOnceWith(
    "measure-touched-pages: could not remove /var/lib/imp/touched-pages-base: rm: cannot remove '/var/lib/imp/touched-pages-base': Device or resource busy\n",
  );
});

test('it fails a measurement whose cleanup left the imp behind', () => {
  const shownImp = buildStubAnswerQueue([
    () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named touched-pages' })),
    () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
  ]);

  const containerRuns: Readonly<Record<string, CommandResult>> = {
    'cat /var/lib/imp/imps/imp_1/run/pid': { exitCode: 0, stdout: '4242\n', stderr: '' },
    'cat /proc/4242/status': { exitCode: 0, stdout: 'HugetlbPages:\t  2048 kB\n', stderr: '' },
    'stat -c %b /var/lib/imp/imps/imp_1/snapshot/mem': {
      exitCode: 0,
      stdout: '2048\n',
      stderr: '',
    },
    'cat /var/lib/imp/imps/imp_1/run/uffd.pid': { exitCode: 0, stdout: '4343\n', stderr: '' },
    'bun /src/scripts/bench/count-changed-pages.ts /var/lib/imp/touched-pages-base /var/lib/imp/imps/imp_1/snapshot/mem':
      { exitCode: 0, stdout: '{"changedMib":1,"changedHugeMib":2}\n', stderr: '' },
  };

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      client: {
        system: {
          info: () => Promise.resolve(buildMockSystemInfo({ defaults: { image: 'base' } })),
        },
        imps: {
          get: () => shownImp.next()(),
          create: () => Promise.resolve(buildMockImp({ id: 'imp_1', name: 'touched-pages' })),
          destroy: () =>
            Promise.reject(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'the disk is busy' })),
        },
      },
      runImpz: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      runInContainer: (argv) =>
        Promise.resolve(containerRuns[argv.join(' ')] ?? { exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', memoryMib: 1024, writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: the cleanup failed, so the dev instance keeps a leftover',
  );
});
