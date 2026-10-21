import type { Caller } from '../../identity/auth/caller';
import type { Revocations } from '../../identity/auth/revocations';
import type { TokenStore } from '../../identity/auth/token-store';
import { createTtlCache } from '../../platform/process/ttl-cache';
import { hashSecret } from '../../platform/secrets/hash-secret';
import { isSameDigest } from '../../platform/secrets/is-same-digest';
import { mintOpaqueToken } from '../../platform/secrets/mint-opaque-token';
import { parseOpaqueToken } from '../../platform/secrets/parse-opaque-token';

const TICKET_PREFIX = '';
const TICKET_TTL_MS = 30_000;
const MAX_LIVE_TICKETS_PER_CALLER = 32;
const MAX_LIVE_TICKETS = 1024;

interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

interface TicketHolder {
  readonly name: string;
  readonly caller: Caller;
}

export interface ExecTickets {
  readonly issue: (name: string, caller: Caller) => IssuedTicket;
  readonly redeem: (ticket: string) => TicketHolder | null;
}

interface LiveTicket {
  readonly secretHash: Buffer;
  readonly holder: TicketHolder;
  readonly owner: string;
}

interface ExecTicketsDeps {
  readonly now: () => number;
  readonly isLive: (caller: Readonly<Caller>) => boolean;
}

export function isCallerLive(
  tokens: Pick<TokenStore, 'findById'>,
  revocations: Pick<Revocations, 'isRevoked'>,
  caller: Readonly<Caller>,
): boolean {
  return (
    (caller.tokenId === null || tokens.findById(caller.tokenId) !== null) &&
    (caller.grantId === null || !revocations.isRevoked(caller.grantId))
  );
}

// A browser WebSocket cannot send the bearer header, and a token must never
// land in a URL, so `/exec` takes a single-use ticket.
export function createExecTickets(deps: Readonly<ExecTicketsDeps>): ExecTickets {
  const now = deps.now;

  // lru-cache keeps an entry until its age passes the ttl, so the ttl is one
  // ms under the ticket's life.
  const live = createTtlCache<string, LiveTicket>({
    max: MAX_LIVE_TICKETS,
    ttlMs: TICKET_TTL_MS - 1,
    now,
  });

  const listOwned = (owner: string): string[] =>
    [...live.rkeys()].filter((id) => live.peek(id)?.owner === owner);

  return {
    issue: (name, caller) => {
      const at = now();
      const owner = readOwner(caller);

      live.purgeStale();

      const owned = listOwned(owner);

      if (owned.length >= MAX_LIVE_TICKETS_PER_CALLER && owned[0] !== undefined) {
        live.delete(owned[0]);
      }

      const minted = mintOpaqueToken(TICKET_PREFIX);
      const expiresAt = at + TICKET_TTL_MS;

      live.set(minted.id, {
        secretHash: hashSecret(minted.secret),
        holder: { name, caller },
        owner,
      });

      return { ticket: minted.text, expiresAt: new Date(expiresAt) };
    },
    redeem: (ticket) => {
      const parsed = parseOpaqueToken(TICKET_PREFIX, ticket);
      const entry = parsed === null ? undefined : live.peek(parsed.id);

      if (
        parsed === null ||
        entry === undefined ||
        !isSameDigest(hashSecret(parsed.secret), entry.secretHash)
      ) {
        return null;
      }

      live.delete(parsed.id);

      return deps.isLive(entry.holder.caller) ? entry.holder : null;
    },
  };
}

function readOwner(caller: Readonly<Caller>): string {
  return caller.tokenId === null ? `${caller.kind}:${caller.name}` : `token:${caller.tokenId}`;
}
