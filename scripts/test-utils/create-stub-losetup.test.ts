import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubLosetup } from './create-stub-losetup';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-losetup-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the free device it was given for -f', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath, { free: '/dev/loop7777 (lost)' });
  const result = Bun.spawnSync([join(stub.bin, 'losetup'), '-f']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '/dev/loop7777 (lost)\n',
  });
});

test('it fails -f without a free device, as on a kernel with none left', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath);
  const result = Bun.spawnSync([join(stub.bin, 'losetup'), '-f']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it prints the device that holds the file for -j', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath, { attached: '/dev/loop3' });

  const result = Bun.spawnSync([
    join(stub.bin, 'losetup'),
    '-j',
    '/data/imp.xfs',
    '-n',
    '-O',
    'NAME',
  ]);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '/dev/loop3\n',
  });
});

test('it prints nothing for -j when no device holds the file', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath);

  const result = Bun.spawnSync([
    join(stub.bin, 'losetup'),
    '-j',
    '/data/imp.xfs',
    '-n',
    '-O',
    'NAME',
  ]);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it attaches a file at the first try by default', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath);
  const result = Bun.spawnSync([join(stub.bin, 'losetup'), '/dev/loop7777', '/data/imp.xfs']);

  expect(result.exitCode).toBe(0);
});

test('it fails the busy attaches it was given, then attaches, across separate runs', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath, { busyAttaches: 2 });

  const exitCodes = Array.from(
    { length: 4 },
    () => Bun.spawnSync([join(stub.bin, 'losetup'), '/dev/loop7777', '/data/imp.xfs']).exitCode,
  );

  expect(exitCodes).toStrictEqual([1, 1, 0, 0]);
});

test('it never counts a detach as an attach', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath, { busyAttaches: 1 });

  Bun.spawnSync([join(stub.bin, 'losetup'), '-d', '/dev/loop7777']);

  const result = Bun.spawnSync([join(stub.bin, 'losetup'), '/dev/loop7777', '/data/imp.xfs']);

  expect(result.exitCode).toBe(1);
});

test('it logs each call with its arguments', () => {
  const ctx = setupTest();
  const stub = createStubLosetup(ctx.directoryPath, { free: '/dev/loop7777' });

  Bun.spawnSync([join(stub.bin, 'losetup'), '-f']);
  Bun.spawnSync([join(stub.bin, 'losetup'), '/dev/loop7777', '/data/imp.xfs']);

  expect(readFileSync(stub.calls, 'utf8')).toBe(
    'losetup -f\nlosetup /dev/loop7777 /data/imp.xfs\n',
  );
});
