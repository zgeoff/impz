import * as dnsPacket from 'dns-packet';
import { parseSubnet } from '../../src/host-net/net/addressing';
import type { QueryVerdict, ResolverDeps } from '../../src/network/egress/egress-resolver';
import type { AddressAnswer } from '../../src/network/egress/egress-sets';
import { resolveNetworkName } from '../../src/network/egress/network-names';
import type { NetworkMember } from '../../src/platform/db/networks';
import { buildMockDnsReply } from './build-mock-dns-reply';
import type { MockDnsRecord } from './build-mock-dns-reply';

interface StubEgressServiceOptions {
  readonly subnet?: string;
  readonly verdicts?: Readonly<Record<number, Readonly<Record<string, QueryVerdict>>>>;
  readonly upstream?: Readonly<Record<string, readonly MockDnsRecord[]>>;
  readonly networks?: readonly string[];
  readonly members?: readonly NetworkMember[];
  readonly screened?: readonly string[];
}

interface AdmittedAnswer {
  readonly slot: number;
  readonly names: readonly string[];
  readonly answers: readonly AddressAnswer[];
}

export function buildStubEgressService(options: Readonly<StubEgressServiceOptions> = {}) {
  const subnet = parseSubnet(options.subnet ?? '10.66.0.0/16');
  const verdicts = options.verdicts ?? {};
  const upstream = options.upstream ?? {};

  const screened = new Set(options.screened);

  const view = { names: new Set(options.networks), members: options.members ?? [] };
  const admitted: AdmittedAnswer[] = [];
  const forwarded: string[] = [];
  const clock = { nowMs: 0 };

  const deps: ResolverDeps = {
    subnet,
    resolveLocal: (slot, query) => resolveNetworkName(view, subnet, { slot, ...query }),
    checkName: (slot, name) => {
      const slotVerdicts = verdicts[slot];
      const verdict = slotVerdicts === undefined ? null : (slotVerdicts[name] ?? 'refuse');

      return Promise.resolve(verdict);
    },
    writeAnswers: (slot, names, answers) => {
      admitted.push({ slot, names, answers });

      return Promise.resolve();
    },
    forward: (query) => {
      const name = dnsPacket.decode(Buffer.from(query)).questions?.[0]?.name ?? '';

      forwarded.push(name);

      // DNS names are case-insensitive.
      const answers = upstream[name.toLowerCase()] ?? [];

      return Promise.resolve(buildMockDnsReply(query, { answers }));
    },
    isScreened: (address) => screened.has(address),
    maxTtlS: 86_400,
    readRate: () => ({ size: 100, refillMs: 100 }),
    now: () => clock.nowMs,
  };

  return {
    deps,
    admitted: admitted as readonly AdmittedAnswer[],
    forwarded: forwarded as readonly string[],
    advance: (durationMs: number): void => {
      clock.nowMs += durationMs;
    },
  };
}
