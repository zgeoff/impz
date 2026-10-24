import { buildWithout } from '@impz/shared';
import { match } from 'ts-pattern';
import type { E2EConfig, HarnessEnv } from './config';
import type { HeadscaleTailnet } from './headscale';
import { HEADSCALE_LOGIN_SERVER, HEADSCALE_TAGS } from './headscale';
import type { TailscaleE2EKey } from './tailscale-key';
import type { TailscaleTailnet } from './tailscale-tailnet';

export type HarnessTailnet =
  | { readonly kind: 'off' }
  | ({ readonly kind: 'headscale' } & HeadscaleTailnet)
  | ({ readonly kind: 'tailscale' } & TailscaleE2EKey & TailscaleTailnet);

interface HarnessEnvOptions {
  readonly env: HarnessEnv;
  readonly hostImage: string;
  readonly config: Pick<E2EConfig, 'ramBudgetMib' | 'idleTimeoutS'>;
  readonly tailnet: HarnessTailnet;
}

// e2e nodes join only as tag:imp-e2e, which reaches no live impd, so dev's own
// key and control server never pass through.
export function buildHarnessEnv(options: Readonly<HarnessEnvOptions>): HarnessEnv {
  const env = {
    ...buildWithout(options.env, [
      'TAILSCALE_AUTHKEY',
      'IMP_TAILSCALE_LOGIN_SERVER',
      'IMP_TAILSCALE_STATE_DIR',
    ]),
    IMP_HOST_IMAGE: options.hostImage,
    IMP_RAM_BUDGET_MIB: String(options.config.ramBudgetMib),
    IMP_IDLE_TIMEOUT_S: String(options.config.idleTimeoutS),
  };

  return match(options.tailnet)
    .with({ kind: 'off' }, () => ({ ...env, IMP_DEV_TAILNET: '0' }))
    .with({ kind: 'headscale' }, (tailnet) => ({
      ...env,
      TAILSCALE_AUTHKEY: tailnet.key,
      IMP_TAILSCALE_TAGS: HEADSCALE_TAGS,
      IMP_TAILSCALE_LOGIN_SERVER: HEADSCALE_LOGIN_SERVER,

      // A node's state in /data would outlive the run's control server.
      IMP_TAILSCALE_STATE_DIR: 'mem',
      IMP_DEV_NETWORK: tailnet.network,
      E2E_TAILNET_MEMBER: tailnet.member,
    }))
    .with({ kind: 'tailscale' }, (tailnet) => ({
      ...env,
      TAILSCALE_AUTHKEY: tailnet.key,
      IMP_TAILSCALE_TAGS: tailnet.tags,

      // A saved node on the same control server and tags stays on its own
      // tailnet, so a node from a production join never comes back.
      IMP_TAILSCALE_STATE_DIR: 'mem',
      E2E_TAILNET_MEMBER: tailnet.member,
    }))
    .exhaustive();
}
