import type { Endpoints } from '@wringer/core';
import { SERVICE_SECRET_ENV } from './constants.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

// One program, a shell whose `impz` is this checkout's CLI, signed in to the run's impd.
// @wringer/terminal starts it with the supervisor's environment, which holds the run's service
// secret, and logs the screen raw, so an `env` in the shell would print the secret.
export function buildTerminalConfig(endpoints: Endpoints, path: string) {
  const run = parseRunEndpoints(endpoints);

  return {
    programs: {
      shell: {
        command: ['bash', '--norc', '--noprofile'],
        env: {
          XDG_CONFIG_HOME: run.configHome,
          PATH: `${run.bin}:${path}`,
          PS1: '$ ',
          [SERVICE_SECRET_ENV]: '',
        },
      },
    },
  };
}
