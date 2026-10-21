import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { Scope } from '@impz/api';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { Caller } from '../auth/caller';
import { buildBadTokenRequest } from './build-bad-token-request';
import { buildConsentBinding } from './build-consent-binding';
import type { Approval, SignIns } from './create-sign-ins';
import { formatApprovalCode } from './create-sign-ins';
import { deriveTokenHash } from './derive-token-hash';
import { expandScopes } from './expand-scopes';
import { formatScopeList, pickGrantScope } from './grant-limits';
import { isSameOriginForm } from './is-same-origin-form';
import {
  buildPageHeaders,
  renderAllowPage,
  renderErrorPage,
  renderPendingPage,
} from './oauth-pages';
import type { SignInErrorPage } from './oauth-pages';
import { readBodyText } from './read-body-text';
import { readErrorDescription } from './read-error-description';
import { readForm } from './read-form';
import { readURLField } from './read-url-field';
import { removeReplayedGrant } from './remove-replayed-grant';
import { removeTokenSessions } from './remove-token-sessions';
import { stripDpopProof } from './strip-dpop-proof';

const MINUTE_MS = 60_000;
const CONSENT_MS = 10 * MINUTE_MS;
const MAX_FORM_BYTES = 16 * 1024;

const RESOURCE_METADATA_PATHS: ReadonlySet<string> = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

export interface AuthServer {
  readonly handler: (request: Request) => Promise<Response>;

  readonly signIn: (oauthQuery: string, approval: Readonly<Approval>) => Promise<Response>;
  readonly readSessionID: (cookie: string) => Promise<string | null>;
  readonly readSecret: () => Promise<string>;
  readonly readSessionCookie: () => Promise<{ readonly name: string; readonly secure: boolean }>;
}

interface OAuthRouterDeps {
  readonly auth: AuthServer;
  readonly db: ImpDatabase;
  readonly signIns: SignIns;
  readonly origin: string;
  readonly resource: string;

  readonly isOn: boolean;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly readApprover: (
    tokenID: string,
    scope: Scope,
    imps: readonly string[] | null,
  ) => Caller | null;
  readonly removeGrantRows: (ids: readonly string[], why: string) => Promise<void>;
}

interface RequestTarget {
  readonly pathname: string;
  readonly search: string;
}

interface SignedIn {
  readonly binding: string;
  readonly approval: Approval;
  readonly clientName: string;
  readonly expiresAt: number;
}

export function makeOAuthRouter(
  deps: Readonly<OAuthRouterDeps>,
): (request: Request) => Promise<Response | null> {
  const host = new URL(deps.origin).host;
  const signedIn = new Map<string, SignedIn>();

  const findSignedIn = (sessionID: string): SignedIn | null => {
    const entry = signedIn.get(sessionID);

    if (entry === undefined || entry.expiresAt <= deps.now()) {
      signedIn.delete(sessionID);

      return null;
    }

    return entry;
  };

  const removeExpiredSignedIn = (): void => {
    const now = deps.now();

    for (const [sessionID, entry] of signedIn) {
      if (entry.expiresAt <= now) {
        signedIn.delete(sessionID);
      }
    }
  };

  const toPublicRequest = (request: Request, url: Readonly<RequestTarget>): Request =>
    new Request(`${deps.origin}${url.pathname}${url.search}`, request);

  const toPublicFormRequest = (
    request: Request,
    url: Readonly<RequestTarget>,
    body: string,
  ): Request =>
    new Request(`${deps.origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: stripDpopProof(request),
      body,
    });

  const readMetadata = async (
    request: Request,
    url: Readonly<RequestTarget>,
  ): Promise<Response> => {
    const response = await deps.auth.handler(toPublicRequest(request, url));
    const metadata: unknown = await response.json();

    if (typeof metadata !== 'object' || metadata === null) {
      return new Response(null, { status: 503 });
    }

    const advertised = Object.fromEntries(
      Object.entries(metadata).filter(
        ([key]) => !key.startsWith('introspection_') && !key.startsWith('dpop_'),
      ),
    );

    const headers = { 'cache-control': 'no-store' };

    if (RESOURCE_METADATA_PATHS.has(url.pathname)) {
      return Response.json(
        { ...advertised, resource_name: 'imp' },
        { status: response.status, headers },
      );
    }

    return Response.json(
      {
        ...advertised,
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
      },
      { headers },
    );
  };

  const runAuthorize = async (url: Readonly<RequestTarget>): Promise<Response> => {
    const params = new URLSearchParams(url.search);

    const asked = (params.get('scope') ?? '').split(' ').filter((word) => word !== '');
    const askedOrRead = asked.length === 0 ? ['read'] : asked;
    const scopes = expandScopes(askedOrRead);

    params.set('prompt', 'login consent');
    params.set('scope', [...scopes, 'offline_access'].join(' '));

    if (!params.has('resource')) {
      params.set('resource', deps.resource);
    }

    const response = await deps.auth.handler(
      new Request(`${deps.origin}/oauth2/authorize?${params.toString()}`, {
        headers: { accept: 'text/html' },
      }),
    );

    const location = response.headers.get('location');
    const target = location === null ? null : new URL(location, deps.origin);

    if (target === null || target.origin !== deps.origin || target.pathname !== '/login') {
      return response;
    }

    const clientID = target.searchParams.get('client_id') ?? '';

    const clientName = await readClientName(deps.db, clientID);

    const started = deps.signIns.start({
      key: target.search.slice(1),
      clientID,
      clientName,
      redirectURI: target.searchParams.get('redirect_uri') ?? '',
      requestedScope: pickGrantScope(scopes),
    });

    if (started.kind === 'too-many') {
      const headers = buildPageHeaders(null);

      headers.set('retry-after', String(started.retryS));

      return new Response(renderErrorPage('too_many'), { status: 429, headers });
    }

    deps.log(`impd: oauth: ${clientName} asks to sign in; it waits for impz oauth approve`);

    return response;
  };

  const runLogin = async (request: Request, url: Readonly<RequestTarget>): Promise<Response> => {
    const form = request.method === 'POST' ? await readForm(request, MAX_FORM_BYTES) : null;

    const oauthQuery =
      request.method === 'GET' ? url.search.slice(1) : (form?.get('oauth_query') ?? '');

    const entry = deps.signIns.find(oauthQuery);

    if (entry === null) {
      return buildErrorPage('expired');
    }

    const buildPendingResponse = (): Response =>
      new Response(
        renderPendingPage(
          {
            oauthQuery,
            clientName: entry.clientName,
            redirectURI: entry.redirectURI,
            requestedScope: entry.requestedScope,
            approvalCode: formatApprovalCode(entry.approvalCode),
          },
          host,
        ),
        { status: 200, headers: buildPageHeaders(new URL(entry.redirectURI).origin) },
      );

    const action = form?.get('action');

    if (request.method === 'GET' || (action === 'continue' && entry.approval === null)) {
      return buildPendingResponse();
    }

    if (action === 'deny') {
      deps.signIns.remove(oauthQuery);

      return buildDenial(oauthQuery);
    }

    const approval = entry.approval;

    if (action !== 'continue' || approval === null) {
      return buildErrorPage('bad_request');
    }

    deps.signIns.remove(oauthQuery);

    if (deps.readApprover(approval.tokenID, approval.scope, approval.imps) === null) {
      return buildErrorPage('approver_gone');
    }

    const signedInResponse = await deps.auth.signIn(oauthQuery, approval);
    const resumed: unknown = await signedInResponse.json();

    const next = readURLField(resumed);
    const setCookies = signedInResponse.headers.getSetCookie();
    const cookie = setCookies.map((line) => line.split(';')[0]).join('; ');

    const sessionID = await deps.auth.readSessionID(cookie);

    if (!signedInResponse.ok || next === null || sessionID === null) {
      deps.log(`impd: oauth: a sign-in for ${entry.clientName} could not reach consent`);

      return buildErrorPage('expired');
    }

    removeExpiredSignedIn();

    signedIn.set(sessionID, {
      binding: buildConsentBinding(oauthQuery),
      approval,
      clientName: entry.clientName,
      expiresAt: deps.now() + CONSENT_MS,
    });

    const headers = new Headers({ location: new URL(next, deps.origin).href });

    for (const line of setCookies) {
      headers.append('set-cookie', line);
    }

    return new Response(null, { status: 302, headers });
  };

  const runConsent = async (request: Request, url: Readonly<RequestTarget>): Promise<Response> => {
    const form = request.method === 'POST' ? await readForm(request, MAX_FORM_BYTES) : null;

    const oauthQuery =
      request.method === 'GET' ? url.search.slice(1) : (form?.get('oauth_query') ?? '');

    const cookie = request.headers.get('cookie') ?? '';
    const prompt = (new URLSearchParams(oauthQuery).get('prompt') ?? '').split(' ');

    const secret = await deps.auth.readSecret();
    const isSigned = await verifyOAuthQueryParams(oauthQuery, secret);

    const sessionID = cookie === '' ? null : await deps.auth.readSessionID(cookie);
    const entry = sessionID === null ? null : findSignedIn(sessionID);

    if (
      !isSigned ||
      prompt.includes('login') ||
      sessionID === null ||
      entry === null ||
      entry.binding !== buildConsentBinding(oauthQuery)
    ) {
      return buildErrorPage('expired');
    }

    const params = new URLSearchParams(oauthQuery);

    const redirectURI = params.get('redirect_uri') ?? '';

    if (request.method === 'GET') {
      return new Response(
        renderAllowPage({
          oauthQuery,
          clientName: entry.clientName,
          redirectURI,
          scope: entry.approval.scope,
          imps: entry.approval.imps,
        }),
        { status: 200, headers: buildPageHeaders(new URL(redirectURI).origin) },
      );
    }

    const action = form?.get('action');

    if (action !== 'allow' && action !== 'deny') {
      return buildErrorPage('bad_request');
    }

    signedIn.delete(sessionID);

    const accept = action === 'allow';
    const scope = `${formatScopeList(entry.approval.scope)} offline_access`;

    const choice = JSON.stringify({
      accept,
      ...(accept && { scope }),
      oauth_query: oauthQuery,
    });

    const consented = await deps.auth.handler(
      new Request(`${deps.origin}/oauth2/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: deps.origin,
          cookie,
        },
        body: choice,
      }),
    );

    const answer: unknown = await consented.json();

    const next = readURLField(answer);
    const isIssued = consented.ok && next !== null && new URL(next).searchParams.has('code');

    // an issued code needs the session for its exchange, which removes it;
    // otherwise the session goes now
    await (isIssued
      ? deps.db
          .updateTable('session')
          .set({ expiresAt: new Date(Date.now() + CONSENT_MS).toISOString() })
          .where('id', '=', sessionID)
          .execute()
      : deps.db.deleteFrom('session').where('id', '=', sessionID).execute());

    if (!consented.ok || next === null) {
      return buildErrorPage('expired');
    }

    if (isIssued) {
      deps.log(
        `impd: oauth: ${entry.clientName} signed in, approved by token ${entry.approval.tokenName}`,
      );
    }

    const sessionCookie = await deps.auth.readSessionCookie();

    const secure = sessionCookie.secure ? '; Secure' : '';

    return new Response(null, {
      status: 302,
      headers: {
        location: next,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': `${sessionCookie.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`,
      },
    });
  };

  // A code exchange binds its tokens to the session that approved them;
  // once issued, no token needs it, so every session a token holds goes,
  // with the expired ones.
  const runTokenRequest = async (
    request: Request,
    url: Readonly<RequestTarget>,
  ): Promise<Response> => {
    const body = await readBodyText(request, MAX_FORM_BYTES);

    if (body === null) {
      return buildBadTokenRequest();
    }

    const response = await deps.auth.handler(toPublicFormRequest(request, url, body));

    if (response.status === 400) {
      await removeReplayedGrant(deps, new URLSearchParams(body));
    }

    if (response.ok) {
      await removeTokenSessions(deps.db);
    }

    return response;
  };

  const runRevoke = async (request: Request, url: Readonly<RequestTarget>): Promise<Response> => {
    const body = await readBodyText(request, MAX_FORM_BYTES);

    if (body === null) {
      return buildBadTokenRequest();
    }

    const form = new URLSearchParams(body);

    const hash = deriveTokenHash(form.get('token') ?? '');

    const owner = await deps.db
      .selectFrom('oauthAccessToken')
      .select(['userId', 'clientId'])
      .where('token', '=', hash)
      .union(
        deps.db
          .selectFrom('oauthRefreshToken')
          .select(['userId', 'clientId'])
          .where('token', '=', hash),
      )
      .executeTakeFirst();

    const response = await deps.auth.handler(toPublicFormRequest(request, url, body));

    // RFC 7009: a token the server does not know is answered as revoked
    if (owner === undefined && response.status === 400) {
      const refusal: unknown = await response.clone().json();

      if (readErrorDescription(refusal) === 'token not found') {
        return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
      }
    }

    if (
      response.ok &&
      owner !== undefined &&
      owner.userId !== null &&
      owner.clientId === form.get('client_id')
    ) {
      await deps.removeGrantRows([owner.userId], 'its client revoked it');
    }

    return response;
  };

  // the issuer goes with the denial (RFC 9207); better-auth signed the query, so
  // its redirect URI is the client's
  const buildDenial = (oauthQuery: string): Response => {
    const params = new URLSearchParams(oauthQuery);
    const target = new URL(params.get('redirect_uri') ?? '');

    const state = params.get('state');

    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'the sign-in was denied');

    if (state !== null) {
      target.searchParams.set('state', state);
    }

    target.searchParams.set('iss', deps.origin);

    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  };

  return (request) => {
    if (!deps.isOn) {
      return Promise.resolve(null);
    }

    const url = new URL(request.url);

    const route = `${request.method} ${url.pathname}`;

    if (
      route === 'GET /.well-known/oauth-authorization-server' ||
      (request.method === 'GET' && RESOURCE_METADATA_PATHS.has(url.pathname))
    ) {
      return readMetadata(request, url);
    }

    // where better-auth sends a refusal it cannot return to the client
    if (route === 'GET /error') {
      const isUnknownClient = url.searchParams.get('error') === 'invalid_client';
      const page = isUnknownClient ? 'unknown_client' : 'bad_request';

      return Promise.resolve(buildErrorPage(page));
    }

    if (route === 'GET /oauth2/authorize') {
      return runAuthorize(url);
    }

    if (route === 'POST /oauth2/token') {
      return runTokenRequest(request, url);
    }

    if (route === 'POST /oauth2/revoke') {
      return runRevoke(request, url);
    }

    const isPage = url.pathname === '/login' || url.pathname === '/consent';

    if (!isPage || (request.method !== 'GET' && request.method !== 'POST')) {
      return Promise.resolve(null);
    }

    if (request.method === 'POST' && !isSameOriginForm(request, deps.origin)) {
      return Promise.resolve(buildErrorPage('bad_request'));
    }

    return url.pathname === '/login' ? runLogin(request, url) : runConsent(request, url);
  };
}

async function readClientName(db: ImpDatabase, clientID: string): Promise<string> {
  const row = await db
    .selectFrom('oauthClient')
    .select('name')
    .where('clientId', '=', clientID)
    .executeTakeFirst();

  return row?.name ?? clientID;
}

function buildErrorPage(error: SignInErrorPage): Response {
  return new Response(renderErrorPage(error), { status: 400, headers: buildPageHeaders(null) });
}
