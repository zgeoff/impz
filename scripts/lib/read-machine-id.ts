import { readFileSync } from 'node:fs';
import type { DevEnv } from './build-dev-layout.ts';

export interface MachineID {
  readonly file: string;
  readonly id: string;
}

// Docker Desktop shares one daemon across WSL distros and devcontainers, whose paths differ, so an
// image's checkout path alone cannot say whether it belongs to this machine.
export function readMachineID(env: DevEnv): MachineID {
  const file = env['IMP_MACHINE_ID_FILE'] || '/etc/machine-id';

  try {
    return { file, id: readFileSync(file, 'utf8').replace(/\n+$/u, '') };
  } catch {
    return { file, id: '' };
  }
}
