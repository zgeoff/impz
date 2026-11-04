import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findUnexpectedReadCode } from './find-unexpected-read-code';
import { getImpdLogger } from './get-impd-logger';

export interface HostLoad {
  readonly cpuStallUs: number | null;
  readonly ioStallUs: number | null;
  readonly memoryStallUs: number | null;
  readonly stealUs: number | null;
}

export const NO_HOST_LOAD: HostLoad = {
  cpuStallUs: null,
  ioStallUs: null,
  memoryStallUs: null,
  stealUs: null,
};

export function readHostLoad(procRoot = '/proc'): HostLoad {
  return {
    cpuStallUs: parsePressureTotal(readProcFile(join(procRoot, 'pressure', 'cpu'))),
    ioStallUs: parsePressureTotal(readProcFile(join(procRoot, 'pressure', 'io'))),
    memoryStallUs: parsePressureTotal(readProcFile(join(procRoot, 'pressure', 'memory'))),
    stealUs: parseStealUs(readProcFile(join(procRoot, 'stat'))),
  };
}

function parsePressureTotal(pressure: string | null): number | null {
  const total = pressure === null ? undefined : /^some .*total=(?<us>\d+)$/mv.exec(pressure);

  return total?.groups?.['us'] === undefined ? null : Number(total.groups['us']);
}

function readProcFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = findUnexpectedReadCode(error);

    if (code !== null) {
      getImpdLogger('imps').warning('cannot read {path} for the host stall: {code}', {
        path,
        code,
      });
    }

    return null;
  }
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
