import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubCurl } from './create-stub-curl';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-curl-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it writes the source file to the path after -o and exits 0', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'linux.tar');
  const output = join(ctx.directoryPath, 'linux.tar.xz.part');

  writeFileSync(source, 'tarball');

  const stub = createStubCurl(ctx.directoryPath, { source });

  const result = Bun.spawnSync([
    join(stub.bin, 'curl'),
    '-fL',
    '--retry',
    '3',
    '-o',
    output,
    'https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.999.tar.xz',
  ]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe('tarball');
});

test('it finds -o wherever it sits among the arguments', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'linux.tar');
  const output = join(ctx.directoryPath, 'out');

  writeFileSync(source, 'tarball');

  const stub = createStubCurl(ctx.directoryPath, { source });

  Bun.spawnSync([join(stub.bin, 'curl'), '-o', output, '-fL', 'https://example.test/linux.tar']);

  expect(readFileSync(output, 'utf8')).toBe('tarball');
});

test('it writes what it had and exits with the code it was given for a failed download', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'partial');
  const output = join(ctx.directoryPath, 'out');

  writeFileSync(source, 'partial');

  const stub = createStubCurl(ctx.directoryPath, { source, exitCode: 22 });

  const result = Bun.spawnSync([
    join(stub.bin, 'curl'),
    '-fL',
    '-o',
    output,
    'https://example.test/linux.tar',
  ]);

  expect(result.exitCode).toBe(22);
  expect(readFileSync(output, 'utf8')).toBe('partial');
});

test('it fails as a usage error without -o', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'linux.tar');

  writeFileSync(source, 'tarball');

  const stub = createStubCurl(ctx.directoryPath, { source });
  const result = Bun.spawnSync([join(stub.bin, 'curl'), '-fL', 'https://example.test/linux.tar']);

  expect(result.exitCode).toBe(2);
});

test('it logs each call with its arguments', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'linux.tar');

  writeFileSync(source, 'tarball');

  const stub = createStubCurl(ctx.directoryPath, { source });

  Bun.spawnSync([
    join(stub.bin, 'curl'),
    '-o',
    join(ctx.directoryPath, 'out'),
    'https://example.test/linux.tar',
  ]);

  expect(readFileSync(stub.calls, 'utf8')).toBe(
    `curl -o ${ctx.directoryPath}/out https://example.test/linux.tar\n`,
  );
});
