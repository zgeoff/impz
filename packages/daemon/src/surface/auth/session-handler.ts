import { sessionContract } from '@impz/api';
import { ORPCError, implement, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { setCookie } from '@orpc/server/helpers';
import { ResponseHeadersPlugin, StrictGetMethodPlugin } from '@orpc/server/plugins';
import invariant from 'tiny-invariant';
import {
  SESSION_MAX_AGE_S,
  buildClearedSessionCookies,
  buildSessionCookie,
  buildSessionValue,
} from '../../identity/auth/session-cookie';
import type { SessionCookie } from '../../identity/auth/session-cookie';
import type { TokenStore } from '../../identity/auth/token-store';
import { isAllowedOrigin } from '../../platform/http/is-allowed-origin';
import { buildForbiddenError } from '../api-errors';

export interface SessionHandlerDeps {
  readonly tokens: TokenStore;
  readonly rootToken: string;
  readonly now: () => number;
  readonly onLogout?: () => void;
  readonly logFailure?: (failure: unknown) => void;
}

interface SessionContext {
  readonly request: Request;
  readonly resHeaders?: Headers;
}

export function createSessionHandler(deps: Readonly<SessionHandlerDeps>) {
  const session = implement(sessionContract)
    .$context<SessionContext>()
    .use((options) => {
      if (!isAllowedOrigin(options.context.request, { kind: 'same-origin' })) {
        throw buildForbiddenError('cross-origin');
      }

      return options.next();
    });

  const auth = session.auth;

  const router = session.router({
    auth: {
      login: auth.login.handler((options) => {
        const caller = deps.tokens.authenticate(options.input.token);

        if (caller?.tokenId === undefined || caller.tokenId === null) {
          throw new ORPCError('UNAUTHORIZED');
        }

        const value = buildSessionValue(deps.rootToken, {
          tokenId: caller.tokenId,
          expiresAt: deps.now() + SESSION_MAX_AGE_S * 1000,
        });

        writeCookie(options.context, buildSessionCookie(value, isSecure(options.context.request)));

        return {};
      }),
      logout: auth.logout.handler((options) => {
        for (const cookie of buildClearedSessionCookies(isSecure(options.context.request))) {
          writeCookie(options.context, cookie);
        }

        deps.onLogout?.();

        return {};
      }),
    },
  });

  const handler = new RPCHandler(router, {
    // A GET is what a link or an <img> on any page can make the browser send.
    plugins: [new StrictGetMethodPlugin(), new ResponseHeadersPlugin()],
    interceptors: [
      onError((failure) => {
        if (!(failure instanceof ORPCError)) {
          deps.logFailure?.(failure);
        }
      }),
    ],
  });

  return {
    respond: async (request: Request): Promise<Response | null> => {
      const handled = await handler.handle(request, { prefix: '/rpc', context: { request } });

      return handled.matched ? handled.response : null;
    },
  };
}

function writeCookie(context: SessionContext, cookie: SessionCookie): void {
  // the response headers plugin puts the headers in every call's context
  invariant(context.resHeaders);
  setCookie(context.resHeaders, cookie.name, cookie.value, cookie.options);
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
