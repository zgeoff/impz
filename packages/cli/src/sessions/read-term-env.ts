import type { CliEnv } from '../config/read-host-config';

export function readTermEnv(env: CliEnv): Record<string, string> {
  return { TERM: env['TERM'] ?? 'xterm-256color' };
}
