import type { Endpoints } from '@wringer/core';
import { createRunClient } from './create-run-client.ts';

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Runs `sh -c <command>` in the imp, through impd's exec socket. impd wakes a sleeping imp for it.
export async function runImpCommand(
  endpoints: Endpoints,
  name: string,
  command: string,
): Promise<CommandResult> {
  const client = await createRunClient(endpoints);
  const result = await client.run(name, ['sh', '-c', command]);

  const decoder = new TextDecoder();

  return {
    exitCode: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}
