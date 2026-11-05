import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText } from '@impz/daemon/read-text';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { waitFor } from '@impz/test-utils/wait-for';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-memory-capped-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const scriptPath = join(import.meta.dir, 'run-memory-capped.sh');
  const memoryStatPath = join(directory, 'memory.stat');
  const peakPath = join(directory, 'anon-peak');

  return {
    memoryStatPath,
    peakPath,
    stubDirectory: join(directory, 'stub'),
    runSample: async () => {
      const result = await $`bash ${scriptPath} --sample ${memoryStatPath} ${peakPath}`
        .nothrow()
        .quiet();

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
    runSampler: (stubBin: string) => {
      const sampler = Bun.spawn(['bash', scriptPath, '--sampler', memoryStatPath, peakPath], {
        env: { ...process.env, PATH: `${stubBin}:${process.env['PATH'] ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      onTestFinished(() => {
        sampler.kill();
      });

      return sampler;
    },
  };
}

test('it keeps the peak and prints nothing when memory.stat cannot be read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(readText(ctx.peakPath)).toBe('4096\n');
});

test('it keeps the peak and prints nothing when memory.stat holds no anon line', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.memoryStatPath, 'file 8192\nkernel 1024\n');
  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(readText(ctx.peakPath)).toBe('4096\n');
});

test('it raises the peak to a higher anon reading', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.memoryStatPath, 'anon 8192\nfile 1024\n');
  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(readText(ctx.peakPath)).toBe('8192\n');
});

test('it keeps the peak above a lower anon reading', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.memoryStatPath, 'anon 2048\nfile 1024\n');
  writeFileSync(ctx.peakPath, '4096\n');

  const result = await ctx.runSample();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(readText(ctx.peakPath)).toBe('4096\n');
});

test('it keeps sampling, and prints nothing, after a sample whose read failed', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.peakPath, '4096\n');

  const sleepStub = createStubBin(ctx.stubDirectory, 'sleep', 'command -p sleep 0.05');
  const sampler = ctx.runSampler(sleepStub.bin);

  await waitFor(() => {
    expect(readText(sleepStub.calls)).toStartWith('sleep 1\nsleep 1\n');
  });

  writeFileSync(ctx.memoryStatPath, 'anon 8192\nfile 1024\n');

  await waitFor(() => {
    expect(readText(ctx.peakPath)).toBe('8192\n');
  });

  sampler.kill();

  await sampler.exited;

  const stderr = await new Response(sampler.stderr).text();

  expect(stderr).toBe('');
});
