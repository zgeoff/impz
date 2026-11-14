import { basename, join } from 'node:path';

export interface KvmInstance {
  // the container name, IMP_DEV_NAME
  readonly name: string;

  // IMP_DEV_DATA, the folder of the instance's XFS file
  readonly dataDir: string;
}

// The dev instance of one run, named after the run's folder, so two runs never share one and a
// leftover is easy to find with `docker ps --filter name=impz-verify-`.
export function buildKvmInstance(runDirectory: string): KvmInstance {
  return {
    name: `impz-verify-${basename(runDirectory)}`,
    dataDir: join(runDirectory, 'data'),
  };
}
