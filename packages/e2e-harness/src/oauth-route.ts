import { createHash, randomBytes } from 'node:crypto';
import { buildStubAuthenticator } from '@zgeoff/mcp-auth/testing';
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

const SignInOptionsSchema = z.object({ challenge: z.string(), rpId: z.string() });

const CreationOptionsSchema = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
});

const PasskeyPageSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('get'), options: SignInOptionsSchema }),
  z.object({ mode: z.literal('create'), options: CreationOptionsSchema }),
]);

export type PasskeyPage = z.infer<typeof PasskeyPageSchema>;

// The login and enroll pages hand the browser the WebAuthn options in one JSON block.
export function parsePasskeyPage(page: string): PasskeyPage | null {
  const block =
    /<script type="application\/json" id="mcp-auth-passkey">(?<json>[^<]*)<\/script>/v.exec(page)
      ?.groups?.['json'];

  if (block === undefined) {
    return null;
  }

  const parsed: unknown = JSON.parse(block);

  return PasskeyPageSchema.parse(parsed);
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
      params: options.params === undefined ? {} : options.params,
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

export type StubAuthenticator = ReturnType<typeof buildStubAuthenticator>;

// impz oauth passkey enroll prints the token on its first line.
export function parseEnrollmentToken(stdout: string): string {
  return /^token: (?<token>\S+)$/mv.exec(stdout)?.groups?.['token'] ?? '';
}

// Enrolls a stub passkey from an enrollment token the CLI prints, as the owner's browser does on
// the enroll page.
export async function enrollPasskey(origin: string): Promise<StubAuthenticator> {
  const enrolled = await tryImp(['oauth', 'passkey', 'enroll']);

  const token = parseEnrollmentToken(enrolled.stdout);

  if (enrolled.exitCode !== 0 || token === '') {
    throw new Error(`impz oauth passkey enroll: ${enrolled.stderr}`);
  }

  const asked = await sendForm(`${origin}/enroll`, { token }, { origin });
  const askedPage = await asked.text();

  const page = parsePasskeyPage(askedPage);

  if (page?.mode !== 'create') {
    throw new Error(`the enroll page answered ${String(asked.status)} with no passkey to create`);
  }

  const authenticator = buildStubAuthenticator();

  const registration = await authenticator.create(page.options, { origin });

  const saved = await sendForm(
    `${origin}/enroll`,
    { token, credential: JSON.stringify(registration) },
    { origin },
  );

  if (saved.status !== 200) {
    throw new Error(`the passkey did not enroll: ${String(saved.status)}`);
  }

  return authenticator;
}

export interface Approval {
  readonly authenticator: StubAuthenticator;
  readonly scopes: readonly string[];
  readonly imps: string;
}

export interface BrowserSignIn {
  readonly login: Response;
  readonly back: URL;
}

export async function runBrowserSignIn(
  authorizationURL: string,
  approval: Readonly<Approval>,
): Promise<BrowserSignIn> {
  const origin = new URL(authorizationURL).origin;

  const authorized = await fetch(authorizationURL, { redirect: 'manual' });

  const loginURL = new URL(authorized.headers.get('location') ?? '/', origin);

  if (loginURL.pathname !== '/login') {
    throw new Error(`authorize answered ${String(authorized.status)} to ${loginURL.href}`);
  }

  const login = await fetch(loginURL);
  const loginPage = await login.text();

  const page = parsePasskeyPage(loginPage);

  if (page?.mode !== 'get') {
    throw new Error(`the login page answered ${String(login.status)} with no passkey sign-in`);
  }

  const assertion = await approval.authenticator.signAssertion(page.options, { origin });

  const signedIn = await sendForm(
    `${origin}/login`,
    { oauth_query: loginURL.search.slice(1), credential: JSON.stringify(assertion) },
    { origin },
  );

  const consentURL = new URL(signedIn.headers.get('location') ?? '/', origin);

  if (consentURL.pathname !== '/consent') {
    throw new Error(`the passkey login answered ${String(signedIn.status)}, not consent`);
  }

  const form = new URLSearchParams({
    oauth_query: consentURL.search.slice(1),
    decision: 'approve',
    imps: approval.imps,
  });

  for (const scope of approval.scopes) {
    form.append('scope', scope);
  }

  const approved = await fetch(`${origin}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin,
      cookie: readCookies(signedIn),
    },
    body: form.toString(),
  });

  const back = new URL(approved.headers.get('location') ?? '/', origin);

  if (!back.searchParams.has('code')) {
    throw new Error(`the consent answered ${String(approved.status)} with no code: ${back.href}`);
  }

  return { login, back };
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
    scope: signIn.scopes.join(' '),
    resource: `${signIn.origin}/mcp`,
  });

  const signedIn = await runBrowserSignIn(
    `${signIn.origin}/oauth2/authorize?${query.toString()}`,
    signIn,
  );

  const exchanged = await sendForm(`${signIn.origin}/oauth2/token`, {
    grant_type: 'authorization_code',
    client_id: signIn.clientId,
    code: signedIn.back.searchParams.get('code') ?? '',
    redirect_uri: signIn.redirect,
    code_verifier: verifier,
    resource: `${signIn.origin}/mcp`,
  });

  const body: unknown = await exchanged.json();

  return RouteTokensSchema.parse(body);
}
