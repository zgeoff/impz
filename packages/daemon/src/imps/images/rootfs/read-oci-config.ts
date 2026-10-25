import * as z from 'zod';
import { buildExitError, runCommand } from '../../../platform/process/run-command';
import type { CommandRunner } from '../../../platform/process/run-command';

const OciConfigSchema = z.object({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/v),
  config: z.record(z.string(), z.unknown()).nullable(),
});

export type OciConfig = z.infer<typeof OciConfigSchema>;

export async function readOciConfig(
  ref: string,
  signal: AbortSignal,
  run: CommandRunner = runCommand,
): Promise<OciConfig> {
  const argv = ['oci-fetch', 'config', ref];

  const result = await run(argv, { signal });

  signal.throwIfAborted();

  if (result.exitCode !== 0) {
    throw buildExitError(argv, result);
  }

  return OciConfigSchema.parse(JSON.parse(result.stdout));
}
