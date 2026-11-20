import type { TailscaleStatus } from '@impz/daemon/host/host-net/net/tailscale-status';

export function readNoTailscale(): Promise<TailscaleStatus> {
  return Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] });
}
