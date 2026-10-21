import type { HostNetfilter } from './read-host-netfilter';

export interface SetupNetGates {
  readonly fullRun: boolean;
  readonly refusals: boolean;
}

export function buildSetupNetGates(netfilter: HostNetfilter): SetupNetGates {
  return {
    fullRun: netfilter.tables && netfilter.rpfilter && netfilter.hl,
    refusals: netfilter.tables,
  };
}
