import type { Dev } from './types.ts';

export async function probeContainerRunning(dev: Dev): Promise<boolean> {
  const inspect = await dev.io
    .shell`${dev.layout.containerCLI} inspect -f ${'{{.State.Running}}'} ${dev.layout.name}`
    .quiet()
    .nothrow();

  return inspect.stdout.toString().trim() === 'true';
}
