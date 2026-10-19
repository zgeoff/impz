import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSparseFilesTar } from './spawn-sparse-files-tar';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'sparse-files-tar-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it streams a tar of each file at its size, as zeros', async () => {
  const ctx = await setupTest();

  const tar = spawnSparseFilesTar(ctx.dir, { big: 3 * 1024 ** 2, small: 10 });

  const listed = Bun.spawnSync(['tar', '-t', '-v', '-f', '-'], {
    stdin: await new Response(tar.stdout).bytes(),
  }).stdout.toString();

  expect(listed).toMatch(/ 3145728 .* big\n.* 10 .* small\n$/v);
});

test('it writes each file as a hole that takes no disk', async () => {
  const ctx = await setupTest();

  const tar = spawnSparseFilesTar(ctx.dir, { big: 64 * 1024 ** 2 });

  await new Response(tar.stdout).arrayBuffer();

  const du = Bun.spawnSync(['du', '-s', '--block-size=1', ctx.dir]).stdout.toString();

  expect(Number(du.split('\t')[0])).toBeLessThan(1024 ** 2);
});

test('it ends a tar that nothing reads when the test ends', async () => {
  const ctx = await setupTest();

  const tar = spawnSparseFilesTar(ctx.dir, { big: 64 * 1024 ** 2 });

  onTestFinished(async () => {
    const code = await tar.exited;

    expect(code).not.toBe(0);
  });
});
