import { createKnownHosts } from './auth/ambient-request';
import { createTailnetIdentities, runWhois } from './auth/tailnet-identity';
import type { AppDeps } from './build-app';
import type { Config } from './config';
import type { ImpdDeps } from './create-impd';
import { createStatusCache } from './net/tailscale-status';
import type { TailscaleStatus } from './net/tailscale-status';

// tailnet identity, when IMP_TAILNET_IDENTITIES has rules; both ask about
// the node on every request, so they share one cached status
export function buildTailnetAccess(
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
