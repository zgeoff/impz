import { $ } from 'bun';

export async function probeContainerRunning(container: string): Promise<boolean> {
  const inspect = await $`docker inspect -f ${'{{.State.Running}}'} ${container}`.quiet().nothrow();

  return inspect.stdout.toString().trim() === 'true';
}
