import { expect, test } from 'bun:test';

function setupTest() {
  return {
    runEntry: (args: readonly string[]) => {
      const result = Bun.spawnSync([
        process.execPath,
        new URL('measure-touched-pages.ts', import.meta.url).pathname,
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

test('it exits 2 and prints its usage for an unknown flag', () => {
  const ctx = setupTest();

  expect(ctx.runEntry(['--colour', 'blue'])).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr:
      'usage: bun packages/daemon/bench/measure-touched-pages.ts [--memory <size>] [--write-mib <n>]\n',
  });
});
