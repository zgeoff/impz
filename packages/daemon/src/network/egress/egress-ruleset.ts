import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressMode } from '@impz/api';

// The table only drops and rejects: an accept in one base chain still passes
// the packet to the next, and a drop in any base chain is final.
const EGRESS_TABLE = 'inet imp_egress';
const NAT66_TABLE = 'ip6 imp_nat66';
const PEER_MARK = '0x01000000';
const OPEN_BLOCKED_RANGES: readonly string[] = ['169.254.0.0/16', '100.64.0.0/10'];

/* @internal */
export interface FirewallSlot {
  readonly slot: number;
  readonly tap: string;
  readonly guestIp: string;

  readonly guestIp6: string | null;
  readonly mode: EgressMode;
  readonly cidrs: readonly string[];
  readonly addresses: readonly string[];
}

export interface NetworkPeer {
  readonly tap: string;
  readonly guestIp: string;
}

export interface RulesetInput {
  readonly slots: readonly FirewallSlot[];

  readonly networks: readonly (readonly NetworkPeer[])[];

  readonly subnet: string;

  readonly dnsServers: readonly string[];

  readonly privateRanges: readonly string[];

  readonly blocked6: readonly string[];

  readonly public4: readonly string[];
  readonly public6: readonly string[];
  readonly uplinks4: readonly string[];
  readonly uplinks6: readonly string[];
  readonly dnsPort: number;
  readonly setSize: number;
}

export function buildRuleset(input: RulesetInput): string {
  const box = input.slots.filter((slot) => EGRESS_MODE_TRAITS[slot.mode].hasAllowList);
  const redirected = input.slots.filter((slot) => EGRESS_MODE_TRAITS[slot.mode].needsRuleset);
  const hasPublic = input.slots.some((slot) => EGRESS_MODE_TRAITS[slot.mode].isPublic);

  const peerTaps = new Set(input.networks.flatMap((peers) => peers.map((peer) => peer.tap)));

  const openPeers = input.slots.filter(
    (slot) => EGRESS_MODE_TRAITS[slot.mode].isOpen && peerTaps.has(slot.tap),
  );

  // one `nft -f` applies all or nothing; the empty table before the delete
  // makes the script work whether or not the table exists, on any kernel
  const lines = [
    `table ${EGRESS_TABLE} {}`,
    `delete table ${EGRESS_TABLE}`,
    `table ${EGRESS_TABLE} {`,
    ...buildSet({
      name: 'private',
      type: 'ipv4_addr',
      elements: input.privateRanges,
      properties: ['flags interval', 'auto-merge'],
    }),
    ...buildSet({
      name: 'blocked6',
      type: 'ipv6_addr',
      elements: input.blocked6,
      properties: ['flags interval', 'auto-merge'],
    }),
    ...(hasPublic ? buildPublicSets(input) : []),
    ...buildSet({
      name: 'dns_taps',
      type: 'ifname',
      elements: redirected.map((slot) => formatTap(slot.tap)),
      properties: [],
    }),
    ...buildSet({
      name: 'open_peer_taps',
      type: 'ifname',
      elements: openPeers.map((slot) => formatTap(slot.tap)),
      properties: [],
    }),
    ...input.networks.flatMap((peers, index) =>
      buildSet({
        name: `net${String(index)}`,
        type: 'ifname . ipv4_addr',
        elements: peers.map((peer) => `${formatTap(peer.tap)} . ${peer.guestIp}`),
        properties: [],
      }),
    ),
    ...box.flatMap((slot) => buildBoxSets(slot, input.setSize)),

    // A refusal: TCP gets a reset, which ends a live connection at once, as
    // after a flush of a tighter policy; ICMP alone leaves it retrying.
    '  chain deny {',
    '    meta l4proto tcp reject with tcp reset',
    '    reject with icmpx admin-prohibited',
    '  }',
    ...input.slots.flatMap((slot) => buildSlotChain(slot)),
    ...buildSet({
      name: 'slots',
      type: 'ifname : verdict',
      elements: input.slots.map((slot) => `${formatTap(slot.tap)} : jump slot${String(slot.slot)}`),
      properties: [],
      kind: 'map',
    }),
    '  chain forward {',
    '    type filter hook forward priority filter - 1; policy accept;',
    '    iifname != "imp*" accept',

    // the mark is set with an OR, so a bit another tool uses survives
    ...input.networks.map(
      (_peers, index) =>
        `    iifname . ip saddr @net${String(index)} oifname . ip daddr @net${String(index)} meta mark set meta mark | ${PEER_MARK} accept`,
    ),
    '    oifname "imp*" goto deny',
    '    iifname vmap @slots',

    '    goto deny',
    '  }',

    // the host's ip6tables INPUT rules may be missing, so a guest's IPv6 to
    // the host container gets neighbour discovery only; iptables owns IPv4
    '  chain input {',
    '    type filter hook input priority filter - 1; policy accept;',
    '    iifname != "imp*" accept',
    '    meta nfproto ipv4 accept',
    '    icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept',
    '    drop',
    '  }',
    '  chain dns {',
    '    type nat hook prerouting priority dstnat - 1; policy accept;',

    `    iifname @dns_taps meta nfproto ipv4 ip daddr != ${input.subnet} meta l4proto { tcp, udp } th dport 53 redirect to :${String(input.dnsPort)}`,
    ...(input.dnsServers.length === 0
      ? []
      : [
          `    iifname @open_peer_taps ip daddr { ${input.dnsServers.join(', ')} } meta l4proto { tcp, udp } th dport 53 redirect to :${String(input.dnsPort)}`,
        ]),
    '  }',
    '}',
  ];

  return `${lines.join('\n')}\n`;
}

export function buildElementChange(
  verb: 'add' | 'delete',
  slot: number,
  addresses: readonly string[],
): string {
  const [ipv4, ipv6] = splitFamilies(addresses);
  const id = String(slot);

  return [
    ipv4.length === 0 ? '' : `${verb} element ${EGRESS_TABLE} allow${id} { ${ipv4.join(', ')} }\n`,
    ipv6.length === 0 ? '' : `${verb} element ${EGRESS_TABLE} allow6${id} { ${ipv6.join(', ')} }\n`,
  ].join('');
}

function buildPublicSets(input: RulesetInput): readonly string[] {
  const interval = ['flags interval', 'auto-merge'];

  return [
    ...buildSet({
      name: 'public4',
      type: 'ipv4_addr',
      elements: input.public4,
      properties: interval,
    }),
    ...buildSet({
      name: 'public6',
      type: 'ipv6_addr',
      elements: input.public6,
      properties: interval,
    }),
    ...buildSet({
      name: 'uplinks4',
      type: 'ifname',
      elements: input.uplinks4.map((uplink) => formatTap(uplink)),
      properties: [],
    }),
    ...buildSet({
      name: 'uplinks6',
      type: 'ifname',
      elements: input.uplinks6.map((uplink) => formatTap(uplink)),
      properties: [],
    }),
  ];
}

function buildBoxSets(slot: FirewallSlot, setSize: number): readonly string[] {
  const id = String(slot.slot);
  const [addresses, addresses6] = splitFamilies(slot.addresses);
  const [cidrs, cidrs6] = splitFamilies(slot.cidrs);
  const size = [`size ${String(setSize)}`];
  const interval = ['flags interval', 'auto-merge'];

  return [
    ...buildSet({ name: `allow${id}`, type: 'ipv4_addr', elements: addresses, properties: size }),
    ...buildSet({ name: `cidr${id}`, type: 'ipv4_addr', elements: cidrs, properties: interval }),
    ...buildSet({ name: `allow6${id}`, type: 'ipv6_addr', elements: addresses6, properties: size }),
    ...buildSet({ name: `cidr6${id}`, type: 'ipv6_addr', elements: cidrs6, properties: interval }),
  ];
}

function splitFamilies(entries: readonly string[]): readonly [string[], string[]] {
  return [
    entries.filter((entry) => !entry.includes(':')),
    entries.filter((entry) => entry.includes(':')),
  ];
}

// the source is checked in each family: the tap's reverse-path check passes
// the rest of the guest's /30, and an `ip` rule never sees IPv6
function buildSlotChain(slot: FirewallSlot): readonly string[] {
  const id = String(slot.slot);

  const body: Record<EgressMode, readonly string[]> = {
    open: [
      `ip daddr { ${OPEN_BLOCKED_RANGES.join(', ')} } goto deny`,
      'ip6 daddr @blocked6 goto deny',
      'accept',
    ],

    // only out of a default route's interface: a route to the tailnet, a
    // Tailscale subnet route or another Docker network leaves by another
    // interface, whatever address it carries
    public: [
      'ct state invalid drop',
      'meta nfproto ipv4 oifname != @uplinks4 goto deny',
      'meta nfproto ipv6 oifname != @uplinks6 goto deny',
      'ip daddr @public4 goto deny',
      'ip6 daddr @public6 goto deny',
      'accept',
    ],
    box: [
      'ct state invalid drop',
      'ct state established,related accept',
      `ip daddr @cidr${id} accept`,
      'ip daddr @private goto deny',
      `ip daddr @allow${id} accept`,
      `ip6 daddr @cidr6${id} accept`,
      'ip6 daddr @blocked6 goto deny',
      `ip6 daddr @allow6${id} accept`,
      'goto deny',
    ],
    none: ['goto deny'],
  };

  const source6 =
    slot.guestIp6 === null ? 'meta nfproto ipv6 drop' : `ip6 saddr != ${slot.guestIp6} drop`;

  return [
    `  chain slot${id} {`,
    `    ip saddr != ${slot.guestIp} drop`,
    `    ${source6}`,
    ...body[slot.mode].map((rule) => `    ${rule}`),
    '  }',
  ];
}

interface BuildSetOptions {
  readonly name: string;
  readonly type: string;
  readonly elements: readonly string[];
  readonly properties: readonly string[];
  readonly kind?: 'set' | 'map';
}

function buildSet(options: BuildSetOptions): readonly string[] {
  const elements = options.elements;

  return [
    `  ${options.kind ?? 'set'} ${options.name} {`,
    `    type ${options.type}`,
    ...options.properties.map((property) => `    ${property}`),
    ...(elements.length === 0 ? [] : [`    elements = { ${elements.join(', ')} }`]),
    '  }',
  ];
}

function formatTap(tap: string): string {
  return `"${tap}"`;
}

export function buildNat66Removal(): string {
  return `table ${NAT66_TABLE} {}\ndelete table ${NAT66_TABLE}\n`;
}

export function buildNat66Ruleset(prefix: string, uplink: string): string {
  return [
    `table ${NAT66_TABLE} {}`,
    `delete table ${NAT66_TABLE}`,
    `table ${NAT66_TABLE} {`,
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    oifname "${uplink}" ip6 saddr ${prefix} masquerade`,
    '  }',
    '}',
    '',
  ].join('\n');
}
