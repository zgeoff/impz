import * as dnsPacket from 'dns-packet';
import { parseSubnet } from '../../host-net/net/derive-slot-address';
import type { QueryVerdict, ResolverDeps } from '../../network/egress/create-query-handler';
import type { AddressAnswer } from '../../network/egress/egress-sets';
import { resolveNetworkName } from '../../network/egress/resolve-network-name';
import type { NetworkMember } from '../../platform/db/list-networks';
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

  const publishedAdmitted: readonly AdmittedAnswer[] = admitted;
  const publishedForwarded: readonly string[] = forwarded;

  return {
    deps,
    admitted: publishedAdmitted,
    forwarded: publishedForwarded,
    advance: (durationMs: number): void => {
      clock.nowMs += durationMs;
    },
  };
}
