import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';

test('it prints the client’s reset as the last line of stdout, as JSON', async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-cut-docker-proxy-stream.ts')],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  expect(output.trimEnd().split('\n').at(-1)).toBe('{"client":"ECONNRESET"}');
}, 30_000);
