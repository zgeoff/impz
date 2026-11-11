import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IdentityTrustDocument } from '@impz/api';
import { verifyImpIdentity } from '@impz/client/identity';
import { parseStubJwtSegment } from '../../../test-utils/network/parse-stub-jwt-segment';
import { loadOrCreateIdentity } from './load-or-create-identity';

async function setupTest() {
  const startMs = Date.UTC(2026, 11, 1, 3, 0, 0);

  const root = await mkdtemp(join(tmpdir(), 'identity-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const clock = { nowMs: startMs };
  const directory = join(root, 'broker', 'identity');

  const load = () =>
    loadOrCreateIdentity({ directory, issuer: 'imp-host-a', now: () => clock.nowMs });

  const verify = (
    token: string,
    document: IdentityTrustDocument,
    nowSeconds = Math.floor(clock.nowMs / 1000),
  ) =>
    verifyImpIdentity(token, { issuers: [document], audience: 'tasks.imp.internal', nowSeconds });

  return {
    directory,
    clock,
    load,
    verify,
    imp: { id: '0192f3a1-7b2c-7d4e-8f10-3a5b6c7d8e9f', name: 'dev-7f3a' },
    startSeconds: Math.floor(startMs / 1000),
    decodeHeader: (token: string) => parseStubJwtSegment(token, 0),
    decodeClaims: (token: string) => parseStubJwtSegment(token, 1),
  };
}

test('it makes the key owner-only in an owner-only directory', async () => {
  const ctx = await setupTest();

  ctx.load();

  expect(statSync(ctx.directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(ctx.directory, 'key.pem')).mode & 0o777).toBe(0o600);
});

test('it keeps the same key across starts', async () => {
  const ctx = await setupTest();

  const first = ctx.load().readDocument();

  expect(ctx.load().readDocument()).toStrictEqual(first);
});

test('it prints one P-256 key for the issuer, and retires none', async () => {
  const ctx = await setupTest();

  const document: unknown = ctx.load().readDocument();

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

test('it prints no private member in the document', async () => {
  const ctx = await setupTest();

  const printed = JSON.stringify(ctx.load().readDocument());

  expect(printed).not.toContain('"d"');
});

test('it signs a token that its own document verifies, for the imp and the audience', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const token = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  expect(ctx.verify(token, identity.readDocument())).resolves.toStrictEqual({
    issuer: 'imp-host-a',
    id: ctx.imp.id,
    name: ctx.imp.name,
  });
});

test('it signs claims with a 55 second life and the issuer setting', async () => {
  const ctx = await setupTest();

  const token = ctx.load().mintToken(ctx.imp, 'tasks.imp.internal');

  expect(ctx.decodeClaims(token)).toStrictEqual({
    iss: 'imp-host-a',
    sub: ctx.imp.id,
    aud: 'tasks.imp.internal',
    iat: ctx.startSeconds,
    exp: ctx.startSeconds + 55,
    jti: expect.stringMatching(/^[0-9a-f]{32}$/u) as unknown,
    imp_name: ctx.imp.name,
  });
});

test('it names the key in the token header by the thumbprint in the document', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const token = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  expect(ctx.decodeHeader(token)).toStrictEqual({
    alg: 'ES256',
    typ: 'JWT',
    kid: identity.readDocument().keys[0]?.kid,
  });
});

test('it signs two tokens with different jti values', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const first = identity.mintToken(ctx.imp, 'tasks.imp.internal');
  const second = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  expect(ctx.decodeClaims(first)['jti']).not.toBe(ctx.decodeClaims(second)['jti']);
});

test('it refuses a switch time that is not in the future', async () => {
  const ctx = await setupTest();

  expect(ctx.load().stageKey(ctx.startSeconds)).toStrictEqual({ kind: 'not-in-future' });
});

test('it prints both keys and retires the old one at the switch time once staged', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const before = identity.readDocument();
  const switchAt = ctx.startSeconds + 600;

  identity.stageKey(switchAt);

  const staged = identity.readDocument();

  expect(staged.keys).toHaveLength(2);
  expect(staged.keys[0]).toStrictEqual(before.keys[0]);
  expect(staged.retire).toStrictEqual([{ kid: before.keys[0]?.kid ?? '', at: switchAt }]);
});

test('it refuses a second stage while one waits, which has no cancel', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();

  identity.stageKey(ctx.startSeconds + 600);

  expect(identity.stageKey(ctx.startSeconds + 900)).toStrictEqual({ kind: 'already-staged' });
});

test('it keeps the staged key private in an owner-only file', async () => {
  const ctx = await setupTest();

  ctx.load().stageKey(ctx.startSeconds + 600);

  expect(statSync(join(ctx.directory, 'next.pem')).mode & 0o777).toBe(0o600);
});

test('it signs with the old key one second before the switch time and the new key at it', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const switchAt = ctx.startSeconds + 600;
  const [oldKey] = identity.readDocument().keys;

  identity.stageKey(switchAt);

  const [, newKey] = identity.readDocument().keys;

  ctx.clock.nowMs = (switchAt - 1) * 1000;

  const beforeToken = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  ctx.clock.nowMs = switchAt * 1000;

  const atToken = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  expect([ctx.decodeHeader(beforeToken)['kid'], ctx.decodeHeader(atToken)['kid']]).toStrictEqual([
    oldKey?.kid,
    newKey?.kid,
  ]);
});

test('it deletes the old private key at the switch time and prints the new key only', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const switchAt = ctx.startSeconds + 600;
  const oldPem = readFileSync(join(ctx.directory, 'key.pem'), 'utf8');

  identity.stageKey(switchAt);

  const newPem = readFileSync(join(ctx.directory, 'next.pem'), 'utf8');

  ctx.clock.nowMs = switchAt * 1000;

  const document = identity.readDocument();

  expect(readFileSync(join(ctx.directory, 'key.pem'), 'utf8')).toBe(newPem);
  expect(newPem).not.toBe(oldPem);
  expect(existsSync(join(ctx.directory, 'next.pem'))).toBeFalse();
  expect(existsSync(join(ctx.directory, 'next.json'))).toBeFalse();
  expect(document.keys).toHaveLength(1);
  expect(document.retire).toStrictEqual([]);
});

test('it accepts a new stage once the switch is done', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const switchAt = ctx.startSeconds + 600;

  identity.stageKey(switchAt);

  ctx.clock.nowMs = switchAt * 1000;

  expect(identity.stageKey(switchAt + 600)).toStrictEqual({ kind: 'staged' });
});

test('it switches at its start when it was down at the switch time', async () => {
  const ctx = await setupTest();

  const switchAt = ctx.startSeconds + 600;
  const first = ctx.load();

  first.stageKey(switchAt);

  const newKeys = first.readDocument().keys.slice(1);

  ctx.clock.nowMs = (switchAt + 3600) * 1000;

  expect(ctx.load().readDocument().keys).toStrictEqual(newKeys);
});

test('it keeps the staged key across a start before the switch time', async () => {
  const ctx = await setupTest();

  const first = ctx.load();

  first.stageKey(ctx.startSeconds + 600);

  expect(ctx.load().readDocument()).toStrictEqual(first.readDocument());
});

test('it drops a staged key that has no switch time, which a crash in the stage leaves', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();

  identity.stageKey(ctx.startSeconds + 600);

  const oldKeys = identity.readDocument().keys.slice(0, 1);

  await rm(join(ctx.directory, 'next.json'));

  expect(ctx.load().readDocument().keys).toStrictEqual(oldKeys);
  expect(existsSync(join(ctx.directory, 'next.pem'))).toBeFalse();
});

test('it refuses, for a service with the old document, a token of the new key before the service has the staged document', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const oldDocument = identity.readDocument();
  const switchAt = ctx.startSeconds + 600;

  identity.stageKey(switchAt);

  ctx.clock.nowMs = switchAt * 1000;

  const token = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  expect(ctx.verify(token, oldDocument, switchAt)).resolves.toBeNull();
});

test('it accepts, for a service with the staged document, the old key until 55 seconds after the switch and the new key throughout', async () => {
  const ctx = await setupTest();

  const identity = ctx.load();
  const switchAt = ctx.startSeconds + 600;

  identity.stageKey(switchAt);

  const staged = identity.readDocument();

  ctx.clock.nowMs = (switchAt - 1) * 1000;

  const oldToken = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  ctx.clock.nowMs = switchAt * 1000;

  const newToken = identity.mintToken(ctx.imp, 'tasks.imp.internal');

  const results = await Promise.all([
    ctx.verify(oldToken, staged, switchAt + 54),
    ctx.verify(oldToken, staged, switchAt + 55),
    ctx.verify(newToken, staged, switchAt),
    ctx.verify(newToken, staged, switchAt + 60),
  ]);

  expect(results.map((result) => result !== null)).toStrictEqual([true, false, true, true]);
});
