import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpReader } from './make-op-reader.ts';
import { readTailscaleAuthkey } from './read-tailscale-authkey.ts';
import { readTextOrNull } from './read-text-or-null.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-tskey-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { root: directory, warn: mock<(line: string) => void>() };
}

test('it takes the key from the env without asking op', async () => {
  const ctx = setupTest();
  const readOp = mock<OpReader>(() => Promise.resolve('fake-from-op'));

  const found = await readTailscaleAuthkey({
    env: {
      TAILSCALE_AUTHKEY: 'fake-tskey-from-env',
      IMP_TAILSCALE_OP: '1',
      IMP_OP_VAULT: 'example',
    },
    root: ctx.root,
    readOp,
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toStrictEqual({ key: 'fake-tskey-from-env', tags: null });
  expect(readOp).not.toHaveBeenCalled();
});

test("it joins with impz's tag:imp-e2e client from op, ephemeral and preauthorized", async () => {
  const ctx = setupTest();
  const readOp = mock<OpReader>(() => Promise.resolve('tskey-client-fake?ephemeral=false'));

  const found = await readTailscaleAuthkey({
    env: { IMP_TAILSCALE_OP: '1', IMP_OP_VAULT: 'example' },
    root: ctx.root,
    readOp,
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toStrictEqual({
    key: 'tskey-client-fake?ephemeral=true&preauthorized=true',
    tags: 'tag:imp-e2e',
  });

  expect(readOp).toHaveBeenCalledExactlyOnceWith(
    'op://example/imp-e2e-tailscale-oauth/client-secret',
  );
});

test('it keeps the tags IMP_TAILSCALE_TAGS sets for a client secret from op', async () => {
  const ctx = setupTest();

  const found = await readTailscaleAuthkey({
    env: { IMP_TAILSCALE_OP: '1', IMP_OP_VAULT: 'example', IMP_TAILSCALE_TAGS: 'tag:sandbox-dev' },
    root: ctx.root,
    readOp: () => Promise.resolve('tskey-client-fake-other'),
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toStrictEqual({
    key: 'tskey-client-fake-other?ephemeral=true&preauthorized=true',
    tags: 'tag:sandbox-dev',
  });
});

test('it reads the reference IMP_TAILSCALE_AUTHKEY_REF names', async () => {
  const ctx = setupTest();
  const readOp = mock<OpReader>(() => Promise.resolve('fake-plain-key'));

  const found = await readTailscaleAuthkey({
    env: { IMP_TAILSCALE_OP: '1', IMP_TAILSCALE_AUTHKEY_REF: 'op://other/key/field' },
    root: ctx.root,
    readOp,
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toStrictEqual({ key: 'fake-plain-key', tags: null });
  expect(readOp).toHaveBeenCalledExactlyOnceWith('op://other/key/field');
});

test('it never asks op without IMP_TAILSCALE_OP=1', async () => {
  const ctx = setupTest();
  const readOp = mock<OpReader>(() => Promise.resolve('fake-from-op'));

  const found = await readTailscaleAuthkey({
    env: { IMP_OP_VAULT: 'example' },
    root: ctx.root,
    readOp,
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toBeNull();
  expect(readOp).not.toHaveBeenCalled();
});

test('it skips op without a vault, names the variables to set, and falls back to .env', async () => {
  const ctx = setupTest();
  const readOp = mock<OpReader>(() => Promise.resolve('fake-from-op'));

  writeFileSync(join(ctx.root, '.env'), "OTHER=1\nTAILSCALE_AUTHKEY='fake-tskey-from-env'\n");

  const found = await readTailscaleAuthkey({
    env: { IMP_TAILSCALE_OP: '1' },
    root: ctx.root,
    readOp,
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toStrictEqual({ key: 'fake-tskey-from-env', tags: null });
  expect(readOp).not.toHaveBeenCalled();

  expect(ctx.warn).toHaveBeenCalledExactlyOnceWith(
    'impz: set IMP_OP_VAULT to the 1Password vault that holds imp-e2e-tailscale-oauth/client-secret, or IMP_TAILSCALE_AUTHKEY_REF to its reference',
  );
});

test('it falls back to the last key in .env when op has none', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.root, '.env'),
    'TAILSCALE_AUTHKEY=fake-old\nTAILSCALE_AUTHKEY="fake-new"\n',
  );

  const found = await readTailscaleAuthkey({
    env: { IMP_TAILSCALE_OP: '1', IMP_OP_VAULT: 'example' },
    root: ctx.root,
    readOp: () => Promise.resolve(''),
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toStrictEqual({ key: 'fake-new', tags: null });
});

test('it reads no key when no source has one', async () => {
  const ctx = setupTest();

  const found = await readTailscaleAuthkey({
    env: {},
    root: ctx.root,
    readOp: null,
    warn: ctx.warn,
    readText: readTextOrNull,
  });

  expect(found).toBeNull();
});
