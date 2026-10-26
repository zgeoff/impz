import type { PebbleNames } from './build-pebble-names';
import { runDocker } from './run-docker';

export interface PebbleEndpoints {
  readonly directoryUrl: string;
  readonly rootUrl: string;
  readonly challtestsrvUrl: string;

  readonly minicaFile: string;
  readonly minicaPem: string;
}

export async function readPebbleEndpoints(names: PebbleNames): Promise<PebbleEndpoints> {
  const directory = await readPublishedPort(names.pebble, 14_000);
  const management = await readPublishedPort(names.pebble, 15_000);
  const challtestsrv = await readPublishedPort(names.challtestsrv, 8055);
  const minicaPem = await Bun.file(names.minicaFile).text();

  return {
    directoryUrl: `https://localhost:${directory}/dir`,
    rootUrl: `https://localhost:${management}/roots/0`,
    challtestsrvUrl: `http://127.0.0.1:${challtestsrv}`,
    minicaFile: names.minicaFile,
    minicaPem,
  };
}

export function parsePublishedPort(container: string, port: number, out: string): string {
  const published = /:(?<port>\d+)\s*$/mu.exec(out.trim())?.groups?.['port'];

  if (published === undefined) {
    throw new Error(`${container} publishes no port for ${String(port)}: ${out.trim()}`);
  }

  return published;
}

async function readPublishedPort(container: string, port: number): Promise<string> {
  const out = await runDocker(['port', container, `${String(port)}/tcp`]);

  return parsePublishedPort(container, port, out);
}
