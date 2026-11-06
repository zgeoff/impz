import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { CommandTimeoutError } from './command-timeout-error';
import { runCommand } from './instance';

test('#runCommand kills a command past its limit with a CommandTimeoutError, even when a child holds its output', () => {
  const running = runCommand(['bash', '-c', 'sleep 3; echo done'], { timeoutMs: 200 });

  expect(running).rejects.toThrowWithMessage(
    CommandTimeoutError,
    'bash -c sleep 3; echo done ran past its limit of 200 ms and was killed',
  );
});

test('#runCommand fails at its limit when a command exits but leaves a child that holds its output', () => {
  const running = runCommand(['bash', '-c', 'sleep 3 & exit 0'], { timeoutMs: 200 });

  expect(running).rejects.toThrowWithMessage(
    CommandTimeoutError,
    'bash -c sleep 3 & exit 0 ran past its limit of 200 ms and was killed',
  );
});

test('#runCommand lets its process exit at the limit when a child of the command holds its output', async () => {
  const script = [
    `import { runCommand } from ${JSON.stringify(join(import.meta.dir, 'instance.ts'))};`,
    `await runCommand(['bash', '-c', 'sleep 5 & exit 0'], { timeoutMs: 100 }).catch(() => undefined);`,
  ].join('\n');

  const started = performance.now();

  const child = Bun.spawn([process.execPath, '--eval', script], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await child.exited;

  expect(performance.now() - started).toBeLessThan(3000);
});

test('#runCommand returns the output of a command that ends inside its limit', async () => {
  const result = await runCommand(['bash', '-c', 'echo sawdust; exit 3'], { timeoutMs: 5000 });

  expect(result).toStrictEqual({ exitCode: 3, stdout: 'sawdust\n', stderr: '' });
});
