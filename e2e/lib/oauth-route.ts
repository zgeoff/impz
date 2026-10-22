import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod';
import { tryImp } from './imp-cli';
import type { DevInstance } from './instance';

export const RouteTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
});

export type RouteTokens = z.infer<typeof RouteTokensSchema>;

export function buildRouteOrigin(target: Readonly<Pick<DevInstance, 'portOffset'>>): string {
  return `http://127.0.0.1:${String(7071 + target.portOffset)}`;
}

export function buildPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface ApprovalPage {
  readonly code: string;

  readonly oauthQuery: string;
}

export function parseApprovalPage(page: string): ApprovalPage {
  const query = /name="oauth_query" value="(?<query>[^"]+)"/v.exec(page)?.groups?.['query'] ?? '';

  return {
    code: /impz oauth approve (?<code>[A-Z0-9\-]+)/v.exec(page)?.groups?.['code'] ?? '',
    oauthQuery: query.replaceAll('&amp;', '&'),
  };
}

export function parseMcpBody(text: string): unknown {
  const events = text.split('\n').filter((line) => line.startsWith('data: '));
  const last = events.at(-1)?.slice('data: '.length) ?? text;

  try {
    const parsed: unknown = JSON.parse(last);

    return parsed;
  } catch {
    return last;
  }
}

export function readCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

// As a browser posts a page's form under a same-origin referrer policy:
// Origin null, and the Sec-Fetch-Site the browser sets itself.
export const BROWSER_FORM = { origin: 'null', 'sec-fetch-site': 'same-origin' };

export function sendForm(
  url: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export interface McpAnswer {
  readonly status: number;
  readonly session: string;
  readonly body: unknown;
}

interface SendMcpOptions {
  readonly origin: string;
  readonly bearer: string;
  readonly session: string;
  readonly method: string;
  readonly params?: unknown;
}

export async function sendMcp(options: SendMcpOptions): Promise<McpAnswer> {
  const session = options.session;

  const response = await fetch(`${options.origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session !== '' && { 'mcp-session-id': session }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: options.method,
      params: options.params ?? {},
    }),
  });

  const text = await response.text();

  return {
    status: response.status,
    session: response.headers.get('mcp-session-id') ?? '',
    body: parseMcpBody(text),
  };
}

export async function openRouteMcp(origin: string, bearer: string): Promise<string> {
  const opened = await sendMcp({
    origin,
    bearer,
    session: '',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1.0.0' },
    },
  });

  if (opened.status !== 200) {
    throw new Error(`initialize answered ${String(opened.status)}: ${JSON.stringify(opened.body)}`);
  }

  return opened.session;
}

export interface Approval {
  readonly approverToken: string;
  readonly scope: string;
}

export async function runBrowserSignIn(
  authorizationURL: string,
  approval: Readonly<Approval>,
): Promise<URL> {
  const origin = new URL(authorizationURL).origin;

  const authorized = await fetch(authorizationURL, { redirect: 'manual' });

  const loginURL = new URL(authorized.headers.get('location') ?? '/', origin);

  if (loginURL.pathname !== '/login') {
    throw new Error(`authorize answered ${String(authorized.status)} to ${loginURL.href}`);
  }

  const login = await fetch(loginURL);
  const loginPage = await login.text();

  const page = parseApprovalPage(loginPage);

  const approved = await tryImp(
    ['oauth', 'approve', page.code, '--scope', approval.scope, '--yes'],
    { token: approval.approverToken },
  );

  if (approved.exitCode !== 0) {
    throw new Error(`impz oauth approve: ${approved.stderr}`);
  }

  const continued = await sendForm(
    `${origin}/login`,
    { oauth_query: page.oauthQuery, action: 'continue' },
    BROWSER_FORM,
  );

  const consentURL = new URL(continued.headers.get('location') ?? '/', origin);

  if (consentURL.pathname !== '/consent') {
    throw new Error(`Continue answered ${String(continued.status)}, not a redirect to consent`);
  }

  const allowed = await sendForm(
    `${origin}/consent`,
    { oauth_query: consentURL.search.slice(1), action: 'allow' },
    { ...BROWSER_FORM, cookie: readCookies(continued) },
  );

  const back = new URL(allowed.headers.get('location') ?? '/', origin);

  if (!back.searchParams.has('code')) {
    throw new Error(`Allow answered ${String(allowed.status)} with no code: ${back.href}`);
  }

  return back;
}

export interface SignIn extends Approval {
  readonly origin: string;
  readonly clientId: string;
  readonly redirect: string;
}

export async function runSignIn(signIn: Readonly<SignIn>): Promise<RouteTokens> {
  const verifier = randomBytes(32).toString('base64url');

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: signIn.clientId,
    redirect_uri: signIn.redirect,
    code_challenge: buildPkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'e2e',
    scope: 'read exec',
    resource: `${signIn.origin}/mcp`,
  });

  const back = await runBrowserSignIn(
    `${signIn.origin}/oauth2/authorize?${query.toString()}`,
    signIn,
  );

  const exchanged = await sendForm(`${signIn.origin}/oauth2/token`, {
    grant_type: 'authorization_code',
    client_id: signIn.clientId,
    code: back.searchParams.get('code') ?? '',
    redirect_uri: signIn.redirect,
    code_verifier: verifier,
    resource: `${signIn.origin}/mcp`,
  });

  const body: unknown = await exchanged.json();

  return RouteTokensSchema.parse(body);
}
