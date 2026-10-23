import type { DevEnv } from './build-dev-layout.ts';

export function toProcessEnv(env: DevEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
