import { isAllowedOrigin } from '../../platform/http/is-allowed-origin';
import { readSession, readSessionCookies } from '../../platform/http/session-cookie';
import type { Caller } from '../../platform/principal/caller';
import { isAllowedAmbientRequest } from './ambient-request';
import type { KnownHosts } from './ambient-request';
import type { TailnetIdentities } from './tailnet-identity';
import { findBearer } from './token-store';
import type { TokenStore } from './token-store';

export interface CallerSources {
  readonly tokens: TokenStore;
  readonly rootToken: string;
  readonly now: () => number;

  readonly tailnet: {
    readonly identities: TailnetIdentities;
    readonly knownHosts: KnownHosts;
  } | null;
}

export interface CallerOptions {
  readonly peer: string | null;

  readonly cookie: boolean;
}

export async function resolveCaller(
  request: Request,
  sources: Readonly<CallerSources>,
  options: Readonly<CallerOptions>,
): Promise<Caller | null> {
  const bearer = findBearer(request.headers.get('authorization'));

  if (bearer !== null) {
    return sources.tokens.authenticate(bearer);
  }

  // imps serve pages on other ports of this host, which SameSite counts as the
  // same site, so only a same-origin request may use the cookie
  if (options.cookie && isAllowedOrigin(request, { kind: 'same-origin' })) {
    const session = readSessionCaller(request, sources);

    if (session !== null) {
      return session;
    }
  }

  if (sources.tailnet === null || options.peer === null) {
    return null;
  }

  const hosts = await sources.tailnet.knownHosts.read();

  if (!isAllowedAmbientRequest(request, hosts)) {
    return null;
  }

  return sources.tailnet.identities.resolve(options.peer);
}

function readSessionCaller(request: Request, sources: Readonly<CallerSources>): Caller | null {
  const at = sources.now();

  // an imp's page can plant its own imp_session on a longer path, which the
  // browser sends first, so every session value is tried
  for (const value of readSessionCookies(request.headers.get('cookie'))) {
    const claim = readSession(value, sources.rootToken, at);
    const caller = claim === null ? null : sources.tokens.findById(claim.tokenId);

    if (claim !== null && caller !== null) {
      return { ...caller, kind: 'dashboard', expiresAt: claim.expiresAt };
    }
  }

  return null;
}
