import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostLoad } from '../../src/platform/process/read-host-load';

const US_PER_TICK = 10_000;

export function createStubHostLoad(
  procRoot: string,
  load: Readonly<Record<keyof HostLoad, number>>,
): void {
  mkdirSync(join(procRoot, 'pressure'), { recursive: true });

  writeFileSync(
    join(procRoot, 'pressure', 'cpu'),
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=${String(load.cpuStallUs)}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );

  writeFileSync(
    join(procRoot, 'pressure', 'io'),
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=${String(load.ioStallUs)}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );

  writeFileSync(
    join(procRoot, 'pressure', 'memory'),
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=${String(load.memoryStallUs)}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );

  writeFileSync(
    join(procRoot, 'stat'),
    `cpu  1000 0 500 90000 20 0 10 ${String(Math.round(load.stealUs / US_PER_TICK))} 0 0\n`,
  );
}
