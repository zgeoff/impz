import { expect, test } from 'bun:test';

function setupTest() {
  return {
    runEntry: (args: readonly string[]) => {
      const result = Bun.spawnSync([
        process.execPath,
        new URL('run-bench-arms.ts', import.meta.url).pathname,
        ...args,
      ]);

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

test('it exits 2 and prints its usage when no arm is given', () => {
  const ctx = setupTest();

  expect(ctx.runEntry(['--out', 'results'])).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr:
      'usage: bun packages/daemon/bench/run-bench-arms.ts --out <dir> [--rounds <n>] --arm <name>=<checkout>... [-- <impz bench args>]\n',
  });
});
