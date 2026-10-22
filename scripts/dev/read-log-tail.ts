import { $ } from 'bun';

export async function readLogTail(container: string, lines: number): Promise<string> {
  const logs = await $`docker logs --tail ${lines} ${container}`.quiet().nothrow();

  return `${logs.stdout.toString()}${logs.stderr.toString()}`;
}
