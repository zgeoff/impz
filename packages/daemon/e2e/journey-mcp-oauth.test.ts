import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { instance } from '@impz/e2e-harness/instance';
import {
  RouteTokensSchema,
  buildPkceChallenge,
  buildRouteOrigin,
  enrollPasskey,
  openRouteMcp,
  runBrowserSignIn,
  runSignIn,
  sendForm,
  sendMcp,
} from '@impz/e2e-harness/oauth-route';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent, removeOAuthClientIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import invariant from 'tiny-invariant';
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

test('it signs a client in with the owner’s passkey, and the grant lists the tools its scope allows and runs a command in the imps the consent names', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}box`;
  const clientName = `${ctx.prefix}conn`;

  await runImp('new', box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const authenticator = await enrollPasskey(ctx.origin);

  registerRemoval(ctx.stack, config.keep, async () => {
    await ctx.client.oauth.passkeys.delete({ id: authenticator.credentialID });
  });

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

  const signedIn = await runBrowserSignIn(`${ctx.origin}/oauth2/authorize?${query.toString()}`, {
    authenticator,
    scopes: ['read', 'exec'],
    imps: `${ctx.prefix}*`,
  });

  const caught = await fetch(signedIn.back);

  expect(signedIn.login.status).toBe(200);
  expect(signedIn.back.searchParams.get('iss')).toBe(ctx.origin);
  expect(signedIn.back.searchParams.get('state')).toBe('e2e');
  expect(caught.status).toBe(200);

  const exchanged = await sendForm(`${ctx.origin}/oauth2/token`, {
    grant_type: 'authorization_code',
    client_id: added.clientId,
    code: signedIn.back.searchParams.get('code') ?? '',
    redirect_uri: ctx.redirect,
    code_verifier: verifier,
    resource: `${ctx.origin}/mcp`,
  });

  const exchangedBody: unknown = await exchanged.json();

  const tokens = RouteTokensSchema.parse(exchangedBody);

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
  expect(grants).toContain('passkey');
});

test('it stops the command a grant runs when the grant is revoked, then answers 401', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}stop-box`;
  const clientName = `${ctx.prefix}stop-conn`;

  await runImp('new', box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const authenticator = await enrollPasskey(ctx.origin);

  registerRemoval(ctx.stack, config.keep, async () => {
    await ctx.client.oauth.passkeys.delete({ id: authenticator.credentialID });
  });

  const tokens = await runSignIn({
    origin: ctx.origin,
    clientId: added.clientId,
    redirect: ctx.redirect,
    authenticator,
    scopes: ['read', 'exec'],
    imps: `${ctx.prefix}*`,
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

  const grants = await ctx.client.oauth.grants.list();

  const grant = grants.find((listed) => listed.client === clientName);

  invariant(grant);

  const started = Date.now();

  await runImp('oauth', 'grant', 'rm', grant.id);

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
