import { expect, test } from 'bun:test';
import { runBunShell } from './run-bun-shell.ts';

test('it runs a command when an object calls it as a method', async () => {
  const io = { shell: runBunShell };

  const output = await io.shell`echo ${'a b'}`.text();

  expect(output).toBe('a b\n');
});

test('it gives the exit code of a command that fails', async () => {
  const io = { shell: runBunShell };

  const result = await io.shell`exit 3`.nothrow();

  expect(result.exitCode).toBe(3);
});
