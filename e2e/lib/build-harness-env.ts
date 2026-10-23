import { buildWithout } from '@impz/shared';
import type { E2EConfig, HarnessEnv } from './config';
import type { TailscaleE2EKey } from './tailscale-key';

interface HarnessEnvOptions {
  readonly env: HarnessEnv;
  readonly hostImage: string;
  readonly config: Pick<E2EConfig, 'ramBudgetMib' | 'idleTimeoutS'>;
  readonly tailnet: TailscaleE2EKey | null;
}

// The env the dev script and every journey start with. e2e nodes join only as
// tag:imp-e2e, which reaches no live impd, so dev's own key never passes through.
export function buildHarnessEnv(options: Readonly<HarnessEnvOptions>): HarnessEnv {
  const env = {
    ...buildWithout(options.env, ['TAILSCALE_AUTHKEY']),
    IMP_HOST_IMAGE: options.hostImage,
    IMP_RAM_BUDGET_MIB: String(options.config.ramBudgetMib),
    IMP_IDLE_TIMEOUT_S: String(options.config.idleTimeoutS),
  };

  if (options.tailnet === null) {
    return { ...env, IMP_DEV_TAILNET: '0' };
  }

  return {
    ...env,
    TAILSCALE_AUTHKEY: options.tailnet.key,
    IMP_TAILSCALE_TAGS: options.tailnet.tags,
  };
}
