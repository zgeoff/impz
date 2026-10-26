import { join } from 'node:path';

export type PebbleNames = ReturnType<typeof buildPebbleNames>;

export function buildPebbleNames(prefix: string, minicaDir: string) {
  return {
    prefix,
    network: `${prefix}-acme`,
    pebble: `${prefix}-pebble`,
    challtestsrv: `${prefix}-challtestsrv`,
    minicaFile: join(minicaDir, `${prefix}-pebble-minica.pem`),
  } as const;
}
