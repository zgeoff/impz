import { expect, test } from 'bun:test';
import { CommandTimeoutError } from './command-timeout-error';
import { runCommand } from './instance';

test('#runCommand kills a command past its limit with a CommandTimeoutError, even when a child holds its output', () => {
  const running = runCommand(['bash', '-c', 'sleep 30; echo done'], { timeoutMs: 200 });

  expect(running).rejects.toThrowWithMessage(
    CommandTimeoutError,
    'bash -c sleep 30; echo done ran past its limit of 200 ms and was killed',
  );
});

test('#runCommand returns the output of a command that ends inside its limit', async () => {
  const result = await runCommand(['bash', '-c', 'echo sawdust; exit 3'], { timeoutMs: 5000 });

  expect(result).toStrictEqual({ exitCode: 3, stdout: 'sawdust\n', stderr: '' });
});
