import { join } from 'node:path';
import type { Logger } from '@logtape/logtape';
import { findUnexpectedReadCode } from './find-unexpected-read-code';

export interface HostLoad {
  readonly cpuStallUs: number | null;
  readonly ioStallUs: number | null;
  readonly memoryStallUs: number | null;
  readonly stealUs: number | null;
}

export interface HostLoadSources {
  readonly procRoot: string;
  readonly readFile: (path: string) => string;
  readonly logger: Pick<Logger, 'warning'>;
}

export const NO_HOST_LOAD: HostLoad = {
  cpuStallUs: null,
  ioStallUs: null,
  memoryStallUs: null,
  stealUs: null,
};

export function readHostLoad(sources: Readonly<HostLoadSources>): HostLoad {
  const readProc = (...names: readonly string[]) =>
    readProcFile(sources, join(sources.procRoot, ...names));

  return {
    cpuStallUs: parsePressureTotal(readProc('pressure', 'cpu')),
    ioStallUs: parsePressureTotal(readProc('pressure', 'io')),
    memoryStallUs: parsePressureTotal(readProc('pressure', 'memory')),
    stealUs: parseStealUs(readProc('stat')),
  };
}

function readProcFile(sources: Readonly<HostLoadSources>, path: string): string | null {
  try {
    return sources.readFile(path);
  } catch (error) {
    const code = findUnexpectedReadCode(error);

    if (code !== null) {
      sources.logger.warning('cannot read {path} for the host stall: {code}', { path, code });
    }

    return null;
  }
}

function parsePressureTotal(pressure: string | null): number | null {
  const total = pressure === null ? undefined : /^some .*total=(?<us>\d+)$/mv.exec(pressure);

  return total?.groups?.['us'] === undefined ? null : Number(total.groups['us']);
}

// The steal column of the `cpu` line, after user, nice, system, idle, iowait,
// irq and softirq.
const STEAL_FIELD = 8;

// /proc/stat counts CPU time in USER_HZ ticks, hundredths of a second.
const US_PER_TICK = 10_000;

function parseStealUs(stat: string | null): number | null {
  const fields = stat
    ?.split('\n')
    .find((line) => line.startsWith('cpu '))
    ?.split(/\s+/v);

  const steal = fields?.[STEAL_FIELD];

  return steal === undefined ? null : Number(steal) * US_PER_TICK;
}
