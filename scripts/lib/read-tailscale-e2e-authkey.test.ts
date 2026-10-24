import { expect, mock, test } from 'bun:test';
import type { OpReader } from './make-op-reader.ts';
import { readTailscaleE2EAuthkey } from './read-tailscale-e2e-authkey.ts';

test('it joins e2e nodes with the test tailnet’s tag:imp-e2e client from op, ephemeral and preauthorized', async () => {
  const readOp = mock<OpReader>(() => Promise.resolve('fake-tskey-client'));

  const found = await readTailscaleE2EAuthkey({
    env: { IMP_OP_VAULT: 'example' },
    readOp,
    warn: () => {},
  });

  expect(found).toStrictEqual({
    key: 'fake-tskey-client?ephemeral=true&preauthorized=true',
    tags: 'tag:imp-e2e',
  });

  expect(readOp).toHaveBeenCalledExactlyOnceWith(
    'op://example/imp-e2e-test-tailnet-authkeys/client-secret',
  );
});

test('it reads the reference IMP_E2E_TAILSCALE_OAUTH_REF names over the vault', async () => {
  const readOp = mock<OpReader>(() => Promise.resolve('fake-tskey-client'));

  await readTailscaleE2EAuthkey({
    env: { IMP_OP_VAULT: 'example', IMP_E2E_TAILSCALE_OAUTH_REF: 'op://other/client/secret' },
    readOp,
    warn: () => {},
  });

  expect(readOp).toHaveBeenCalledExactlyOnceWith('op://other/client/secret');
});

test('it takes the e2e client secret from IMP_E2E_TAILSCALE_AUTHKEY without asking op', async () => {
  const readOp = mock<OpReader>(() => Promise.resolve('fake-from-op'));

  const found = await readTailscaleE2EAuthkey({
    env: { IMP_E2E_TAILSCALE_AUTHKEY: 'fake-client-secret?ephemeral=false' },
    readOp,
    warn: () => {},
  });

  expect(found).toStrictEqual({
    key: 'fake-client-secret?ephemeral=true&preauthorized=true',
    tags: 'tag:imp-e2e',
  });

  expect(readOp).not.toHaveBeenCalled();
});

test('it never asks op without a vault, and names the variables to set', async () => {
  const readOp = mock<OpReader>(() => Promise.resolve('fake-from-op'));
  const warn = mock<(line: string) => void>();

  const found = await readTailscaleE2EAuthkey({ env: {}, readOp, warn });

  expect(found).toBeNull();
  expect(readOp).not.toHaveBeenCalled();

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'impz: set IMP_OP_VAULT to the 1Password vault that holds imp-e2e-test-tailnet-authkeys/client-secret, or IMP_E2E_TAILSCALE_OAUTH_REF to its reference',
  );
});

test("it never gives e2e nodes dev's tag:imp key from TAILSCALE_AUTHKEY", async () => {
  const found = await readTailscaleE2EAuthkey({
    env: { TAILSCALE_AUTHKEY: 'fake-tag-imp-key', IMP_OP_VAULT: 'example' },
    readOp: () => Promise.resolve(''),
    warn: () => {},
  });

  expect(found).toBeNull();
});
