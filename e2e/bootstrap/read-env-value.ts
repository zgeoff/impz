import { findEnvValue } from './find-env-value';
import { readInContainer } from './read-in-container';
import type { BootstrapRun } from './types';

// A key the env file lacks reads as empty, as the bash script's sed gave it.
export async function readEnvValue(run: BootstrapRun, key: string): Promise<string> {
  const env = await readInContainer(run, ['cat', '/etc/imp/imp-host.env']);

  return findEnvValue(env.output, key) ?? '';
}
