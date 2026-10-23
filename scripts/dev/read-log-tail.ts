import type { DevIO } from './types.ts';

export async function readLogTail(io: DevIO, container: string, lines: number): Promise<string> {
  const logs = await io.shell`docker logs --tail ${lines} ${container}`.quiet().nothrow();

  return `${logs.stdout.toString()}${logs.stderr.toString()}`;
}
