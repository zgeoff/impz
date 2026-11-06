import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, tryImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { instance } from '@impz/e2e-harness/instance';
import {
  BROWSER_FORM,
  RouteTokensSchema,
  buildPkceChallenge,
  buildRouteOrigin,
  openRouteMcp,
  parseApprovalPage,
  readCookies,
  runSignIn,
  sendForm,
  sendMcp,
} from '@impz/e2e-harness/oauth-route';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import {
  removeImpIfPresent,
  removeOAuthClientIfPresent,
  removeTokenIfPresent,
} from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import * as z from 'zod';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  const origin = buildRouteOrigin(instance);

  const catcher = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: { '/*': () => new Response('signed in') },
  });

  stack.defer(() => catcher.stop(true));

  return {
    prefix: getSuitePrefix('mcp-oauth'),
    stack,
    client,
    origin,
    redirect: `http://127.0.0.1:${String(catcher.port)}/callback`,
  };
}

test('it signs a client in on an approval from the CLI, and the grant lists the tools its scope allows and runs a command in its imps', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}box`;
  const clientName = `${ctx.prefix}conn`;
  const approver = `${ctx.prefix}approver`;

  await runImp('new', box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const token = await ctx.client.tokens.create({
    name: approver,
    scope: 'exec',
    imps: [`${ctx.prefix}*`],
  });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, approver));

  const verifier = randomBytes(32).toString('base64url');

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: added.clientId,
    redirect_uri: ctx.redirect,
    code_challenge: buildPkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'e2e',
    scope: 'read exec',
    resource: `${ctx.origin}/mcp`,
  });

  const authorized = await fetch(`${ctx.origin}/oauth2/authorize?${query.toString()}`, {
    redirect: 'manual',
  });

  const loginURL = new URL(authorized.headers.get('location') ?? '/', ctx.origin);

  const opened = await fetch(loginURL);
  const page = await opened.text();

  const approval = parseApprovalPage(page);

  expect(opened.status).toBe(200);
  expect(opened.headers.get('referrer-policy')).toBe('same-origin');

  const approved = await tryImp(['oauth', 'approve', approval.code, '--scope', 'exec', '--yes'], {
    token: token.secret,
  });

  expect(approved).toStrictEqual({
    exitCode: 0,
    stdout: expect.toBeString(),
    stderr: expect.toIncludeMultiple([
      `client:       ${clientName}`,
      `returns to:   ${ctx.redirect}`,
    ]),
  });

  const continued = await sendForm(
    `${ctx.origin}/login`,
    { oauth_query: approval.oauthQuery, action: 'continue' },
    BROWSER_FORM,
  );

  const consentURL = new URL(continued.headers.get('location') ?? '/', ctx.origin);

  const consentQuery = consentURL.search.slice(1);

  const allowed = await sendForm(
    `${ctx.origin}/consent`,
    { oauth_query: consentQuery, action: 'allow' },
    { ...BROWSER_FORM, cookie: readCookies(continued) },
  );

  const location = new URL(allowed.headers.get('location') ?? '');

  const caught = await fetch(location);

  expect(allowed.status).toBe(302);
  expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');
  expect(location.searchParams.get('iss')).toBe(ctx.origin);
  expect(location.searchParams.get('state')).toBe('e2e');
  expect(caught.status).toBe(200);

  const exchanged = await sendForm(`${ctx.origin}/oauth2/token`, {
    grant_type: 'authorization_code',
    client_id: added.clientId,
    code: location.searchParams.get('code') ?? '',
    redirect_uri: ctx.redirect,
    code_verifier: verifier,
    resource: `${ctx.origin}/mcp`,
  });

  const exchangedBody: unknown = await exchanged.json();

  const tokens = RouteTokensSchema.parse(exchangedBody);

  expect(tokens.scope).toBe('read exec offline_access');

  const session = await openRouteMcp(ctx.origin, tokens.access_token);

  const listed = await sendMcp({
    origin: ctx.origin,
    bearer: tokens.access_token,
    session,
    method: 'tools/list',
  });

  const ran = await sendMcp({
    origin: ctx.origin,
    bearer: tokens.access_token,
    session,
    method: 'tools/call',
    params: {
      name: 'imp_exec',
      arguments: { name: box, command: 'echo from-the-route' },
    },
  });

  const grants = await runImp('oauth', 'grant', 'ls');

  const tool = z.object({ name: z.string() });

  const names = z
    .object({ result: z.object({ tools: z.array(tool) }) })
    .parse(listed.body)
    .result.tools.map((entry) => entry.name);

  expect(names).toContain('imp_exec');
  expect(names).not.toContain('imp_create');
  expect(JSON.stringify(ran.body)).toContain('from-the-route');
  expect(grants).toContain(clientName);
  expect(grants).toContain(approver);
});

test('it stops the command a grant runs when the approving token goes, then answers 401', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}stop-box`;
  const clientName = `${ctx.prefix}stop-conn`;
  const approver = `${ctx.prefix}stop-approver`;

  await runImp('new', box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const token = await ctx.client.tokens.create({
    name: approver,
    scope: 'exec',
    imps: [`${ctx.prefix}*`],
  });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, approver));

  const tokens = await runSignIn({
    origin: ctx.origin,
    clientId: added.clientId,
    redirect: ctx.redirect,
    approverToken: token.secret,
    scope: 'exec',
  });

  const session = await openRouteMcp(ctx.origin, tokens.access_token);

  const call = sendMcp({
    origin: ctx.origin,
    bearer: tokens.access_token,
    session,
    method: 'tools/call',
    params: {
      name: 'imp_exec',
      arguments: { name: box, command: 'sleep 120', timeoutSeconds: 180 },
    },
  });

  await waitFor('the command to start', async () => {
    const processes = await runImp('exec', box, '--', 'ps');

    if (!processes.includes('sleep 120')) {
      throw new Error('no sleep 120 yet');
    }
  });

  const started = Date.now();

  await runImp('token', 'rm', approver);

  const answered = await call.then(
    (response) => JSON.stringify(response.body).includes('"result"'),
    () => false,
  );

  const elapsedMs = Date.now() - started;

  const after = await sendMcp({
    origin: ctx.origin,
    bearer: tokens.access_token,
    session,
    method: 'ping',
  });

  const processes = await runImp('exec', box, '--', 'ps');

  expect(answered).toBeFalse();
  expect(elapsedMs).toBeLessThan(30_000);
  expect(after.status).toBe(401);
  expect(processes).not.toContain('sleep 120');
});
