import type { CommandResult } from './run-command';

export type StreamedRunner = (
  argv: readonly string[],
  onStdout: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
) => Promise<CommandResult>;

export async function runStreamed(
  argv: readonly string[],
  onStdout: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    signal,
  });

  const stderr = new Response(child.stderr).text();

  try {
    for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
      await onStdout(chunk);
    }
  } catch (error) {
    child.kill();

    await child.exited;

    throw error;
  }

  const exitCode = await child.exited;

  signal.throwIfAborted();

  return { exitCode, stdout: '', stderr: await stderr };
}
