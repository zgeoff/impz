import { expect, onTestFinished, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createImpClient } from '@impz/client';
import { startTestImpd } from '../test-utils/start-test-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const nowMs = Date.UTC(2026, 11, 1, 3, 0, 0);
  const clock = { nowMs };

  const harness = await startTestImpd(stack, {
    env: { IMP_IDENTITY_ISSUER: 'imp-host-a' },
    frozenClockMs: nowMs,
    brokerNow: () => clock.nowMs,
  });

  const sendRequest = (request: Request) => harness.impd.api.app.handle(request);

  const createReader = async () => {
    const made = await harness.client.tokens.create({ name: 'watcher', scope: 'read' });

    return createImpClient({
      url: 'http://impd.test',
      token: made.secret,
      fetch: sendRequest,
    });
  };

  return Object.assign(harness, { stack, brokerClock: clock, startMs: nowMs, createReader });
}

test('it answers the issuer in the system info and the feature as on', async () => {
  const ctx = await setupTest();
  const info = await ctx.client.system.info();

  expect(info.identity).toStrictEqual({ issuer: 'imp-host-a' });
  expect(info.features?.secretIdentity).toBeTrue();
});

test('it answers the feature as on in the features call', async () => {
  const ctx = await setupTest();
  const answer = await ctx.client.system.features();

  expect(answer.features.secretIdentity).toBeTrue();
});

test('it makes the key at start, owner-only, under the data directory', async () => {
  const ctx = await setupTest();

  expect(statSync(join(ctx.dataDir, 'broker', 'identity', 'key.pem')).mode & 0o777).toBe(0o600);
});

test('it answers the key set with the issuer and no retired key', async () => {
  const ctx = await setupTest();
  const document: unknown = await ctx.client.identity.jwks();

  expect(document).toStrictEqual({
    issuer: 'imp-host-a',
    keys: [
      {
        kty: 'EC',
        crv: 'P-256',
        x: expect.any(String) as unknown,
        y: expect.any(String) as unknown,
        kid: expect.any(String) as unknown,
        alg: 'ES256',
        use: 'sig',
      },
    ],
    retire: [],
  });
});

test('it answers the key set to a read-only token', async () => {
  const ctx = await setupTest();
  const reader = await ctx.createReader();
  const document = await reader.identity.jwks();

  expect(document.issuer).toBe('imp-host-a');
});

test('it refuses a key change from a read-only token', async () => {
  const ctx = await setupTest();
  const reader = await ctx.createReader();

  expect(reader.identity.stageKey({ at: new Date(ctx.startMs + 3_600_000) })).rejects.toMatchObject(
    { code: 'FORBIDDEN' },
  );
});

test('it stages a key and answers both keys with the old one retiring at the switch time', async () => {
  const ctx = await setupTest();
  const before = await ctx.client.identity.jwks();

  const at = new Date(ctx.startMs + 3_600_000);

  const staged = await ctx.client.identity.stageKey({ at });
  const printed = await ctx.client.identity.jwks();

  expect(staged.keys).toHaveLength(2);
  expect(staged.keys[0]).toStrictEqual(before.keys[0]);

  expect(staged.retire).toStrictEqual([
    { kid: before.keys[0]?.kid ?? '', at: Math.floor(at.getTime() / 1000) },
  ]);

  expect(printed).toStrictEqual(staged);
});

test('it refuses a switch time in the past', async () => {
  const ctx = await setupTest();

  expect(ctx.client.identity.stageKey({ at: new Date(ctx.startMs - 1000) })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a second stage, which has no cancel', async () => {
  const ctx = await setupTest();

  await ctx.client.identity.stageKey({ at: new Date(ctx.startMs + 3_600_000) });

  expect(
    ctx.client.identity.stageKey({ at: new Date(ctx.startMs + 7_200_000) }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it prints the new key only once the clock passes the switch time', async () => {
  const ctx = await setupTest();

  const at = new Date(ctx.startMs + 3_600_000);

  const staged = await ctx.client.identity.stageKey({ at });

  ctx.brokerClock.nowMs = at.getTime();

  const after = await ctx.client.identity.jwks();

  expect(after).toStrictEqual({ issuer: 'imp-host-a', keys: staged.keys.slice(1), retire: [] });
});
