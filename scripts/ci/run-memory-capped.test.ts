import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-memory-capped-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const memoryStatPath = join(directory, 'memory.stat');
  const peakPath = join(directory, 'anon-peak');

  return {
    memoryStatPath,
    peakPath,
    runSample: async () => {
      const result =
        await $`bash ${join(import.meta.dir, 'run-memory-capped.sh')} --sample ${memoryStatPath} ${peakPath}`
          .nothrow()
          .quiet();

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
    readPeak: () => readFileSync(peakPath, 'utf8'),
  };
}

test('it keeps the peak and prints nothing when memory.stat cannot be read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(ctx.readPeak()).toBe('4096\n');
});

test('it keeps the peak and prints nothing when memory.stat holds no anon line', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.memoryStatPath, 'file 8192\nkernel 1024\n');
  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(ctx.readPeak()).toBe('4096\n');
});

test('it raises the peak to a higher anon reading', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.memoryStatPath, 'anon 8192\nfile 1024\n');
  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(ctx.readPeak()).toBe('8192\n');
});

test('it keeps the peak above a lower anon reading', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.memoryStatPath, 'anon 2048\nfile 1024\n');
  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(ctx.readPeak()).toBe('4096\n');
});
