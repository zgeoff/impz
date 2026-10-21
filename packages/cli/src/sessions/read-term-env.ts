import type { CliEnv } from '../config/host-store';

export function readTermEnv(env: CliEnv): Record<string, string> {
  return { TERM: env['TERM'] ?? 'xterm-256color' };
}
