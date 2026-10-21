import type { Config } from './config';
import { createStatusCache } from './host-net/net/tailscale-status';
import type { TailscaleStatus } from './host-net/net/tailscale-status';
import { createKnownHosts } from './identity/auth/ambient-request';
import { createTailnetIdentities, runWhois } from './identity/auth/tailnet-identity';
import type { ImpdDeps } from './impd-deps';
import type { AppDeps } from './surface/create-app';

// both checks ask tailscaled about the node on every request, so they share one cached status
export function createTailnetAccess(
  config: Config,
  deps: Readonly<Pick<ImpdDeps, 'now' | 'whois'>>,
  readStatus: () => Promise<TailscaleStatus>,
): AppDeps['tailnet'] {
  if (config.tailnetRules === null) {
    return null;
  }

  const now = deps.now ?? Date.now;
  const readTailscale = createStatusCache(readStatus, now);

  return {
    identities: createTailnetIdentities({
      rules: config.tailnetRules,
      whois: deps.whois ?? runWhois,
      readTailscale,
      now,
    }),
    knownHosts: createKnownHosts({
      readTailscale,
      domain: config.https?.domain ?? null,
    }),
  };
}
