import { parseIpv4 } from '../../host-net/net/addressing';
import type { Subnet } from '../../host-net/net/addressing';
import type { NetworkMember } from '../../platform/db/networks';

const INTERNAL = 'internal';

interface LocalRecordBase {
  readonly name: string;
  readonly ttl: number;
  readonly data: string;
}

type LocalRecord =
  | (LocalRecordBase & { readonly type: 'A' })
  | (LocalRecordBase & { readonly type: 'PTR' });

// `records` empty is NOERROR with no data: the name exists, not this type
export type LocalAnswer =
  | { readonly kind: 'nxdomain' }
  | { readonly kind: 'records'; readonly records: readonly LocalRecord[] };

const NXDOMAIN: LocalAnswer = { kind: 'nxdomain' };

export interface NetworkView {
  readonly names: ReadonlySet<string>;
  readonly members: readonly NetworkMember[];
}

export function resolveNetworkName(
  view: Readonly<NetworkView>,
  subnet: Subnet,
  query: Readonly<{ slot: number; name: string; type: string }>,
): LocalAnswer | null {
  const networks = new Set(
    view.members.filter((member) => member.slot === query.slot).map((member) => member.network),
  );

  const peers = view.members.filter((member) => networks.has(member.network));
  const labels = query.name.split('.');

  if (labels.at(-1) === INTERNAL && view.names.has(labels.at(-2) ?? '')) {
    const [imp, network] = labels;

    const peer =
      labels.length === 3
        ? peers.find((each) => each.name === imp && each.network === network)
        : undefined;

    return peer === undefined ? NXDOMAIN : buildAddressAnswer(query, peer.guestIp);
  }

  const reverse = readReverseAddress(query.name, subnet);

  if (reverse !== null) {
    return buildPointerAnswer(query, reverse, peers);
  }

  const peer = query.name.includes('.')
    ? undefined
    : peers.find((each) => each.name === query.name);

  return peer === undefined ? null : buildAddressAnswer(query, peer.guestIp);
}

// short, so a join or a leave shows in a guest's cache soon after
const LOCAL_TTL_S = 5;

function buildAddressAnswer(
  query: Readonly<{ name: string; type: string }>,
  address: string,
): LocalAnswer {
  const records: LocalRecord[] =
    query.type === 'A' ? [{ type: 'A', name: query.name, ttl: LOCAL_TTL_S, data: address }] : [];

  return { kind: 'records', records };
}

const REVERSE_SUFFIX = '.in-addr.arpa';

function readReverseAddress(name: string, subnet: Subnet): string | null {
  if (!name.endsWith(REVERSE_SUFFIX)) {
    return null;
  }

  const octets = name.slice(0, -REVERSE_SUFFIX.length).split('.').toReversed();

  if (octets.length > 4) {
    return null;
  }

  const padded = [...octets, '0', '0', '0', '0'].slice(0, 4).join('.');
  const address = parseIpv4(padded);
  const hostBits = 32 - subnet.prefixLength;

  if (
    address === null ||
    octets.length * 8 < subnet.prefixLength ||
    Math.floor(address / 2 ** hostBits) !== Math.floor(subnet.network / 2 ** hostBits)
  ) {
    return null;
  }

  return octets.length === 4 ? padded : '';
}

function buildPointerAnswer(
  query: Readonly<{ name: string; type: string }>,
  address: string,
  peers: readonly NetworkMember[],
): LocalAnswer {
  const named = peers.filter((peer) => peer.guestIp === address);

  if (named.length === 0) {
    return NXDOMAIN;
  }

  const records: LocalRecord[] =
    query.type === 'PTR'
      ? named.map((peer) => ({
          type: 'PTR',
          name: query.name,
          ttl: LOCAL_TTL_S,
          data: `${peer.name}.${peer.network}.${INTERNAL}`,
        }))
      : [];

  return { kind: 'records', records };
}
