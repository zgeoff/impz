import type { TailscaleStatus } from '../net/tailscale-status';

// tailscaled, as on a host that is not on a tailnet
export function readNoTailscale(): Promise<TailscaleStatus> {
  return Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] });
}
