import { expect, mock, test } from 'bun:test';
import type { CommandRun } from './run-bench-arm';
import { runTouchedPages } from './run-touched-pages';

test('it removes the imp a failed create left behind, then releases the lock', () => {
  const impzRuns: Readonly<Record<string, CommandRun>> = {
    'info --json': {
      exitCode: 0,
      stdout: '{"defaults":{"memoryMib":256,"image":"base"}}',
      stderr: '',
    },
    'info touched-pages --json': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: NOT_FOUND: no imp named touched-pages\n',
    },
    'new touched-pages --memory 1g': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: INTERNAL_SERVER_ERROR: the disk clone failed\n',
    },
    'rm touched-pages': { exitCode: 0, stdout: '', stderr: '' },
  };

  const runImpz = mock((args: readonly string[]) =>
    Promise.resolve(
      impzRuns[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const release = mock(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release }),
      runImpz,
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: impz new touched-pages exited 1: impz: INTERNAL_SERVER_ERROR: the disk clone failed\n',
  );

  expect(runImpz.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'info --json',
    'info touched-pages --json',
    'new touched-pages --memory 1g',
    'rm touched-pages',
  ]);

  expect(release).toHaveBeenCalledAfter(runImpz);
});

test('it leaves an imp of its name that it found before the create', () => {
  const impzRuns: Readonly<Record<string, CommandRun>> = {
    'info --json': {
      exitCode: 0,
      stdout: '{"defaults":{"memoryMib":256,"image":"base"}}',
      stderr: '',
    },
    'info touched-pages --json': { exitCode: 0, stdout: '{"id":"imp_kept"}', stderr: '' },
  };

  const runImpz = mock((args: readonly string[]) =>
    Promise.resolve(
      impzRuns[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const runInContainer = mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));
  const release = mock(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release }),
      runImpz,
      runInContainer,
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: 'not-a-size', writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: touched-pages already exists or could not be looked up, so this run leaves it: ',
  );

  expect(runImpz.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'info --json',
    'info touched-pages --json',
  ]);

  expect(runInContainer).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

test('it leaves an imp of its name that appeared during the run, when impd refuses the create', () => {
  const impzRuns: Readonly<Record<string, CommandRun>> = {
    'info --json': {
      exitCode: 0,
      stdout: '{"defaults":{"memoryMib":256,"image":"base"}}',
      stderr: '',
    },
    'info touched-pages --json': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: NOT_FOUND: no imp named touched-pages\n',
    },
    'new touched-pages --memory 1g': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: CONFLICT: an imp named touched-pages already exists\n',
    },
  };

  const runImpz = mock((args: readonly string[]) =>
    Promise.resolve(
      impzRuns[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
    ),
  );

  const runInContainer = mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      runImpz,
      runInContainer,
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'measure-touched-pages: touched-pages appeared during the run, so this run leaves it',
  );

  expect(runImpz.mock.calls.map((call) => call[0].join(' '))).toStrictEqual([
    'info --json',
    'info touched-pages --json',
    'new touched-pages --memory 1g',
  ]);

  expect(runInContainer).not.toHaveBeenCalled();
});

test('it runs nothing while another bench holds the dev instance', () => {
  const runImpz = mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  const measured = runTouchedPages(
    {
      lockDev: () => {
        throw new Error(
          'process 4242 holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)',
        );
      },
      runImpz,
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr: () => {},
    },
    { memory: '1g', writeMib: 128 },
  );

  expect(measured).rejects.toThrowWithMessage(
    Error,
    'process 4242 holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)',
  );

  expect(runImpz).not.toHaveBeenCalled();
});

test('it reports a cleanup command that failed', () => {
  const impzRuns: Readonly<Record<string, CommandRun>> = {
    'info --json': {
      exitCode: 0,
      stdout: '{"defaults":{"memoryMib":256,"image":"base"}}',
      stderr: '',
    },
    'info touched-pages --json': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: NOT_FOUND: no imp named touched-pages\n',
    },
    'new touched-pages --memory 1g': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: INTERNAL_SERVER_ERROR: the boot failed\n',
    },
    'rm touched-pages': {
      exitCode: 1,
      stdout: '',
      stderr: 'impz: INTERNAL_SERVER_ERROR: the disk is busy\n',
    },
  };

  const onStderr = mock<(text: string) => void>(() => {});

  const measured = runTouchedPages(
    {
      lockDev: () => ({ release: () => {} }),
      runImpz: (args) =>
        Promise.resolve(
          impzRuns[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: 'no such command' },
        ),
      runInContainer: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => 0,
      wait: () => Promise.resolve(),
      onStderr,
    },
    { memory: '1g', writeMib: 128 },
  );

  expect(measured).rejects.toThrow('impz new touched-pages exited 1');

  expect(onStderr).toHaveBeenCalledExactlyOnceWith(
    'measure-touched-pages: could not remove touched-pages: impz: INTERNAL_SERVER_ERROR: the disk is busy\n',
  );
});
