import { expect, test } from 'bun:test';
import { buildHarnessEnv } from './build-harness-env';

test('it turns the tailnet off and drops a key from the shell when the run has no tailnet', () => {
  const env = buildHarnessEnv({
    env: { PATH: '/usr/bin', IMP_DEV_NAME: 'imp-e2e-a', TAILSCALE_AUTHKEY: 'fake-dev-key' },
    hostImage: 'imp-host:dev-imp-0f3a91c2',
    config: { ramBudgetMib: 4096, idleTimeoutS: 20 },
    tailnet: { kind: 'off' },
  });

  expect(env).toStrictEqual({
    PATH: '/usr/bin',
    IMP_DEV_NAME: 'imp-e2e-a',
    IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
    IMP_RAM_BUDGET_MIB: '4096',
    IMP_IDLE_TIMEOUT_S: '20',
    IMP_DEV_TAILNET: '0',
  });
});

test('it joins the dev script and each journey to the run’s Headscale in place of the shell’s tailnet', () => {
  const env = buildHarnessEnv({
    env: {
      PATH: '/usr/bin',
      TAILSCALE_AUTHKEY: 'fake-dev-key',
      IMP_TAILSCALE_TAGS: 'tag:imp',
      IMP_TAILSCALE_LOGIN_SERVER: 'https://control.example.test',
      IMP_TAILSCALE_STATE_DIR: '/var/tmp/imp-ts',
      IMP_DEV_NETWORK: 'imp-e2e-a-own',
    },
    hostImage: 'imp-host:dev-imp-0f3a91c2',
    config: { ramBudgetMib: 6144, idleTimeoutS: 10 },
    tailnet: {
      kind: 'headscale',
      key: 'fake-headscale-key',
      network: 'imp-e2e-a-ts',
      member: 'imp-e2e-a-ts-member',
    },
  });

  expect(env).toStrictEqual({
    PATH: '/usr/bin',
    IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
    IMP_RAM_BUDGET_MIB: '6144',
    IMP_IDLE_TIMEOUT_S: '10',
    TAILSCALE_AUTHKEY: 'fake-headscale-key',
    IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
    IMP_TAILSCALE_LOGIN_SERVER: 'http://headscale:8080',
    IMP_TAILSCALE_STATE_DIR: 'mem',
    IMP_DEV_NETWORK: 'imp-e2e-a-ts',
    E2E_TAILNET_MEMBER: 'imp-e2e-a-ts-member',
  });
});

test('it gives the dev script the e2e Tailscale key and its tag in place of the shell’s tailnet', () => {
  const env = buildHarnessEnv({
    env: {
      PATH: '/usr/bin',
      TAILSCALE_AUTHKEY: 'fake-dev-key',
      IMP_TAILSCALE_TAGS: 'tag:imp',
      IMP_TAILSCALE_LOGIN_SERVER: 'https://control.example.test',
    },
    hostImage: 'imp-host:dev-imp-0f3a91c2',
    config: { ramBudgetMib: 6144, idleTimeoutS: 10 },
    tailnet: {
      kind: 'tailscale',
      key: 'fake-e2e-key?ephemeral=true&preauthorized=true',
      tags: 'tag:imp-e2e',
    },
  });

  expect(env).toStrictEqual({
    PATH: '/usr/bin',
    IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
    IMP_RAM_BUDGET_MIB: '6144',
    IMP_IDLE_TIMEOUT_S: '10',
    TAILSCALE_AUTHKEY: 'fake-e2e-key?ephemeral=true&preauthorized=true',
    IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
  });
});

test('it leaves the shell environment it was given unchanged', () => {
  const shell = { PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-dev-key' };

  buildHarnessEnv({
    env: shell,
    hostImage: 'imp-host:dev-imp-0f3a91c2',
    config: { ramBudgetMib: 6144, idleTimeoutS: 10 },
    tailnet: { kind: 'off' },
  });

  expect(shell).toStrictEqual({ PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-dev-key' });
});
