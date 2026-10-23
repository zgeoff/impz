import { parseNetworkNames } from './parse-network-names';
import { readInContainer } from './read-in-container';
import type { BootstrapRun } from './types';

// The networks the imp-host container is on, joined one per line; none when it has no container.
export async function readImpHostNetworks(run: BootstrapRun): Promise<string> {
  const inspect = await readInContainer(run, [
    'docker',
    'container',
    'inspect',
    '-f',
    '{{json .NetworkSettings.Networks}}',
    'imp-host',
  ]);

  return inspect.exitCode === 0 ? parseNetworkNames(inspect.output).join('\n') : '';
}
