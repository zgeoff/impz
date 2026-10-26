import type { CommandRunners } from './instance';

// Docker refuses to remove a network that a container still holds.
export async function removeDockerNetwork(
  runners: Pick<CommandRunners, 'runCommand'>,
  network: string,
): Promise<void> {
  const attached = await runners.runCommand([
    'docker',
    'ps',
    '-aq',
    '--filter',
    `network=${network}`,
  ]);

  const containers = attached.stdout.split('\n').filter((id) => id !== '');

  if (containers.length > 0) {
    await runners.runCommand(['docker', 'rm', '-f', ...containers]);
  }

  await runners.runCommand(['docker', 'network', 'rm', network]);
}
