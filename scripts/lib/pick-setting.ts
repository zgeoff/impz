import type { DevEnv } from './build-dev-layout.ts';

// As bash's ${NAME:-default} reads it: a variable set empty counts as unset.
export function pickSetting(env: DevEnv, key: string): string | undefined {
  const value = env[key];

  return value === undefined || value === '' ? undefined : value;
}
