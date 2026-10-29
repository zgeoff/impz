import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHugePagePool } from './read-huge-page-pool';

function setupTest() {
  const sysRoot = mkdtempSync(join(tmpdir(), 'imp-hugepages-'));

  onTestFinished(() => {
    rmSync(sysRoot, { recursive: true, force: true });
  });

  return { sysRoot, poolDir: join(sysRoot, 'kernel', 'mm', 'hugepages', 'hugepages-2048kB') };
}

test('it reads the 2 MiB pool, with reserved pages counted as taken', () => {
  const ctx = setupTest();

  mkdirSync(ctx.poolDir, { recursive: true });
  writeFileSync(join(ctx.poolDir, 'nr_hugepages'), '1100\n');
  writeFileSync(join(ctx.poolDir, 'free_hugepages'), '1000\n');
  writeFileSync(join(ctx.poolDir, 'resv_hugepages'), '40\n');

  expect(readHugePagePool(ctx.sysRoot)).toStrictEqual({ totalMib: 2200, freeMib: 1920 });
});

test('it reads no pool on a kernel with no 2 MiB pages', () => {
  const ctx = setupTest();

  expect(readHugePagePool(ctx.sysRoot)).toBeNull();
});

test('it reads an empty pool as no free pages', () => {
  const ctx = setupTest();

  mkdirSync(ctx.poolDir, { recursive: true });
  writeFileSync(join(ctx.poolDir, 'nr_hugepages'), '0\n');
  writeFileSync(join(ctx.poolDir, 'free_hugepages'), '0\n');
  writeFileSync(join(ctx.poolDir, 'resv_hugepages'), '0\n');

  expect(readHugePagePool(ctx.sysRoot)).toStrictEqual({ totalMib: 0, freeMib: 0 });
});

test('it reads the host /sys by default', () => {
  expect(readHugePagePool()).toSatisfy(
    (pool: unknown) => pool === null || (typeof pool === 'object' && 'freeMib' in pool),
  );
});
