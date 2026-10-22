import { ImpPatternSchema, ScopeSchema } from '@impz/api';
import * as z from 'zod';
import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import { runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import { createTtlCache } from '../../platform/process/ttl-cache';
import type { Caller } from './caller';

const TailnetRuleSchema = z
  .object({
    match: z
      .string()
      .regex(/^(?:user:\S+|tag:[\w-]+|\*)$/u, 'must be user:<login>, tag:<tag> or *'),
    scope: ScopeSchema,
    imps: z.array(ImpPatternSchema).min(1).readonly().optional(),
  })
  .readonly();

export type TailnetRule = z.infer<typeof TailnetRuleSchema>;

export const TailnetRulesSchema = z.array(TailnetRuleSchema).min(1).readonly();

export interface TailnetPeer {
  readonly login: string | null;
  readonly tags: readonly string[];

  readonly node: string;

  readonly stableId: string | null;
}

const TagsSchema = z.array(z.string()).nullable().optional();

const WhoisSchema = z.object({
  Node: z.object({ Name: z.string(), Tags: TagsSchema, StableID: z.string().optional() }),
  UserProfile: z.object({ LoginName: z.string() }),
});

const WHOIS_TTL_MS = 60_000;
const MAX_CACHED = 256;

export interface TailnetIdentities {
  readonly resolve: (address: string) => Promise<Caller | null>;
}

interface TailnetIdentitiesDeps {
  readonly rules: readonly TailnetRule[];
  readonly whois: (address: string) => Promise<TailnetPeer | null>;

  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly now: () => number;
}

export function createTailnetIdentities(deps: Readonly<TailnetIdentitiesDeps>): TailnetIdentities {
  // lru-cache keeps an entry until its age passes the ttl, hence one ms less. A
  // hit peeks, so a set past the cap evicts the oldest answer, not the least used.
  const cache = createTtlCache<string, Promise<TailnetPeer | null>>({
    max: MAX_CACHED,
    ttlMs: WHOIS_TTL_MS - 1,
    now: deps.now,
  });

  const readCachedPeer = (address: string): Promise<TailnetPeer | null> => {
    const cached = cache.peek(address);

    if (cached !== undefined) {
      return cached;
    }

    const peer = readWhois(deps.whois, address);

    cache.set(address, peer);

    return peer;
  };

  return {
    resolve: async (address) => {
      if (!isTailnetAddress(address)) {
        return null;
      }

      const plain = normalizeAddress(address);

      // impd itself, or an imp's traffic leaving through the node: the raw
      // rule lets local sources pass, and whois names the node's own tags
      const own = await probeOwnAddress(deps.readTailscale, plain);

      if (own) {
        return null;
      }

      const peer = await readCachedPeer(plain);

      return peer === null ? null : findTailnetCaller(deps.rules, peer);
    },
  };
}

/* @internal */
export function findTailnetCaller(
  rules: readonly TailnetRule[],
  peer: Readonly<TailnetPeer>,
): Caller | null {
  const rule = rules.find((each) => isRuleMatch(each.match, peer));

  if (rule === undefined) {
    return null;
  }

  return {
    kind: 'tailnet',
    name: peer.login ?? peer.node,
    scope: rule.scope,
    imps: rule.imps ?? null,
    grantable: [],
    imageRefPrefix: null,
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: findTailnetPrincipal(peer),
    display: peer.node,
  };
}

// A user owns leases across all of its nodes. A tagged node has no user, so
// it owns them by its stable ID; without one it owns none, since a later
// node can take its name.
function findTailnetPrincipal(peer: Readonly<TailnetPeer>): string | null {
  if (peer.login !== null) {
    return `tailnet-user:${peer.login}`;
  }

  return peer.stableId === null ? null : `tailnet:${peer.stableId}`;
}

/* @internal */
export function parseWhois(json: string): TailnetPeer | null {
  try {
    const whois = WhoisSchema.parse(JSON.parse(json));
    const tags = whois.Node.Tags ?? [];

    return {
      // whois names a tagged node's user as the placeholder `tagged-devices`
      login: tags.length > 0 ? null : whois.UserProfile.LoginName,
      tags,
      node: whois.Node.Name.split('.')[0] ?? whois.Node.Name,
      stableId:
        whois.Node.StableID === undefined || whois.Node.StableID === ''
          ? null
          : whois.Node.StableID,
    };
  } catch {
    return null;
  }
}

export async function runWhois(
  address: string,
  run: CommandRunner = runCommand,
): Promise<TailnetPeer | null> {
  const result = await run(['tailscale', 'whois', '--json', address]);

  return result.exitCode === 0 ? parseWhois(result.stdout) : null;
}

async function readWhois(
  whois: TailnetIdentitiesDeps['whois'],
  address: string,
): Promise<TailnetPeer | null> {
  try {
    return await whois(address);
  } catch {
    return null;
  }
}

async function probeOwnAddress(
  readTailscale: TailnetIdentitiesDeps['readTailscale'],
  address: string,
): Promise<boolean> {
  const status = await readTailscale();

  const wanted = address.toLowerCase();

  return status.ips.some((ip) => ip.toLowerCase() === wanted);
}

// tailscaled drops packets from Tailscale's ranges that do not come in on
// tailscale0, and so does setup-net.sh, so the source address is the peer's.
/* @internal */
export function isTailnetAddress(address: string): boolean {
  const plain = normalizeAddress(address);
  const octets = plain.split('.');

  if (octets.length === 4) {
    return octets[0] === '100' && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
  }

  return /^fd7a:115c:a1e0:/iu.test(plain);
}

// Bun reports an IPv4 peer of a dual-stack socket as ::ffff:a.b.c.d
function normalizeAddress(address: string): string {
  return address.replace(/^::ffff:/iu, '');
}

function isRuleMatch(match: string, peer: Readonly<TailnetPeer>): boolean {
  if (match === '*') {
    return true;
  }

  if (match.startsWith('tag:')) {
    return peer.tags.includes(match);
  }

  return peer.login !== null && match === `user:${peer.login}`;
}
