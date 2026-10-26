import type { Dev } from './types.ts';

export async function readLogTail(dev: Dev, lines: number): Promise<string> {
  const logs = await dev.io
    .shell`${dev.layout.containerCLI} logs --tail ${lines} ${dev.layout.name}`
    .quiet()
    .nothrow();

  return `${logs.stdout.toString()}${logs.stderr.toString()}`;
}
