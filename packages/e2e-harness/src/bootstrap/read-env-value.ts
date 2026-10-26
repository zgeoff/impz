import { findEnvValue } from './find-env-value';
import { readInContainer } from './read-in-container';
import type { BootstrapRun } from './types';

export async function readEnvValue(run: BootstrapRun, key: string): Promise<string> {
  const env = await readInContainer(run, ['cat', '/etc/imp/imp-host.env']);

  return findEnvValue(env.output, key) ?? '';
}
