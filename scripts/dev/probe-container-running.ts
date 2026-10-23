import type { DevIO } from './types.ts';

export async function probeContainerRunning(io: DevIO, container: string): Promise<boolean> {
  const inspect = await io.shell`docker inspect -f ${'{{.State.Running}}'} ${container}`
    .quiet()
    .nothrow();

  return inspect.stdout.toString().trim() === 'true';
}
