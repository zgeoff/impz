import type { NetworkMember } from '../../platform/db/networks';
import type { NetworkPeer } from './egress-ruleset';

// each network's members, by the tap each sends from
export function listPeerGroups(members: readonly NetworkMember[]): NetworkPeer[][] {
  const byNetwork = Map.groupBy(members, (member) => member.network);

  return [...byNetwork.values()].map((group) =>
    group.map((member) => ({ tap: `imp${String(member.slot)}`, guestIp: member.guestIp })),
  );
}
