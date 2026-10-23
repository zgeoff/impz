import type { Subnet } from './net/addressing';
import type { Ipv6Setting } from './net/ipv6-plan';

export interface HostNetConfig {
  readonly portBase: number;
  readonly hostAddresses: readonly string[];
  readonly dns: readonly string[];
  readonly subnet: Subnet;
  readonly ipv6: Ipv6Setting;
}
