import { expect, test } from 'bun:test';
import { buildTerminalConfig } from './build-terminal-config.ts';

test("it gives the shell the run's CLI and blanks the service secret it would inherit", () => {
  const endpoints = {
    web: 'http://127.0.0.1:7570',
    mcp: 'http://127.0.0.1:7571',
    configHome: '/w/imp/.wringer/runs/r1/config',
    bin: '/w/imp/.wringer/runs/r1/bin',
    tokenFile: '/w/imp/.wringer/runs/r1/token',
    blocked: '',
  };

  expect(buildTerminalConfig(endpoints, '/usr/bin:/bin')).toStrictEqual({
    programs: {
      shell: {
        command: ['bash', '--norc', '--noprofile'],
        env: {
          XDG_CONFIG_HOME: '/w/imp/.wringer/runs/r1/config',
          PATH: '/w/imp/.wringer/runs/r1/bin:/usr/bin:/bin',
          PS1: '$ ',
          IMPZ_VERIFY_SERVICE_SECRET: '',
        },
      },
    },
  });
});
