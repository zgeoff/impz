import { probeUnshare } from './probe-unshare';

export interface HostNetfilter {
  readonly tables: boolean;
  readonly rpfilter: boolean;
  readonly hl: boolean;
}

// A kernel can list the tables yet lack a match module, as a cloud imp's lacks
// rpfilter and hl, so each match is probed by appending a rule with it.
export function readHostNetfilter(): HostNetfilter {
  return {
    tables: probeUnshare(['sh', '-c', 'iptables -t nat -S && ip link && command -v sysctl']),
    rpfilter: probeUnshare([
      'sh',
      '-c',
      'iptables -t raw -A PREROUTING -m rpfilter --invert -j DROP && ip6tables -t raw -A PREROUTING -m rpfilter --invert -j DROP',
    ]),
    hl: probeUnshare([
      'sh',
      '-c',
      'ip6tables -A INPUT -p ipv6-icmp --icmpv6-type 133 -m hl --hl-eq 255 -j ACCEPT',
    ]),
  };
}
