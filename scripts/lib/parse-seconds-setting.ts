import type { DevEnv } from './build-dev-layout.ts';
import { DevError } from './dev-error.ts';
import { pickSetting } from './pick-setting.ts';

export function parseSecondsSetting(env: DevEnv, key: string, fallback: number): number {
  const setting = pickSetting(env, key);

  if (setting === undefined) {
    return fallback;
  }

  const seconds = Number(setting);

  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new DevError(`${key}=${setting} is not a number of seconds`);
  }

  return seconds;
}
