import type { DevEnv } from './build-dev-layout.ts';
import { pickSetting } from './pick-setting.ts';

interface MachineID {
  readonly file: string;
  readonly id: string;
}

// Docker Desktop shares one daemon across WSL distros and devcontainers, whose paths differ, so an
// image's checkout path alone cannot say whether it belongs to this machine.
export function readMachineID(readText: (path: string) => string | null, env: DevEnv): MachineID {
  const file = pickSetting(env, 'IMP_MACHINE_ID_FILE') ?? '/etc/machine-id';

  return { file, id: readText(file)?.replace(/\n+$/u, '') ?? '' };
}
