import * as z from 'zod';
import {
  SESSION_MAX_AGE_S,
  buildClearedSessionCookies,
  buildSessionCookie,
  buildSessionValue,
} from '../../identity/auth/session-cookie';
import type { TokenStore } from '../../identity/auth/token-store';
import { isAllowedOrigin } from '../../platform/http/is-allowed-origin';

const LoginSchema = z.object({ token: z.string() });

export interface SessionRouteDeps {
  readonly tokens: TokenStore;
  readonly rootToken: string;
  readonly now: () => number;
  readonly onLogout?: () => void;
}

export function createSessionRoutes(deps: Readonly<SessionRouteDeps>) {
  return {
    login: async (request: Request): Promise<Response> => {
      if (!isAllowedOrigin(request, { kind: 'same-origin' })) {
        return Response.json({ error: 'cross-origin' }, { status: 403 });
      }

      const json = await readJson(request);

      const body = LoginSchema.safeParse(json);
      const caller = body.success ? deps.tokens.authenticate(body.data.token) : null;

      if (caller?.tokenId === undefined || caller.tokenId === null) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const value = buildSessionValue(deps.rootToken, {
        tokenId: caller.tokenId,
        expiresAt: deps.now() + SESSION_MAX_AGE_S * 1000,
      });

      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': buildSessionCookie(value, isSecure(request)) },
      });
    },
    logout: (request: Request): Response => {
      if (!isAllowedOrigin(request, { kind: 'same-origin' })) {
        return Response.json({ error: 'cross-origin' }, { status: 403 });
      }

      const headers = new Headers();

      for (const cookie of buildClearedSessionCookies(isSecure(request))) {
        headers.append('set-cookie', cookie);
      }

      deps.onLogout?.();

      return new Response(null, { status: 204, headers });
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// A TLS front such as tailscale serve sets x-forwarded-proto, but any client
// can send that header, so it only adds Secure to the cookie and never
// decides what a request may do.
function isSecure(request: Request): boolean {
  return (
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https'
  );
}
