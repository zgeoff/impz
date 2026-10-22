import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpReader } from './make-op-reader.ts';
import { writeTailnetOAuthFile } from './write-tailnet-oauth-file.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-oauth-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it writes the OAuth client from the item in IMP_OP_VAULT, owner-only', async () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'data', 'tailnet-oauth.json');

  const answers: Readonly<Record<string, string>> = {
    'op://example/imp-e2e-tailscale-services/client-id': 'fake-client-id',
    'op://example/imp-e2e-tailscale-services/client-secret': 'fake-client-secret',
  };

  const isWritten = await writeTailnetOAuthFile({
    file,
    env: { IMP_OP_VAULT: 'example' },
    readOp: (ref) => Promise.resolve(answers[ref] ?? ''),
    warn: () => {},
  });

  expect(isWritten).toBeTrue();

  expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
  });

  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('it never asks op without a vault, and names the variables to set', async () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'tailnet-oauth.json');
  const readOp = mock<OpReader>(() => Promise.resolve('fake-client-id'));
  const warn = mock<(line: string) => void>();

  const isWritten = await writeTailnetOAuthFile({ file, env: {}, readOp, warn });

  expect(isWritten).toBeFalse();
  expect(readOp).not.toHaveBeenCalled();

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'impz: set IMP_OP_VAULT to the 1Password vault that holds imp-e2e-tailscale-services, or IMP_TAILNET_OAUTH_REF to its reference',
  );

  expect(existsSync(file)).toBeFalse();
});

test('it writes nothing when op has no client secret', async () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'tailnet-oauth.json');

  const answers: Readonly<Record<string, string>> = {
    'op://example/imp-e2e-tailscale-services/client-id': 'fake-client-id',
  };

  const isWritten = await writeTailnetOAuthFile({
    file,
    env: { IMP_OP_VAULT: 'example' },
    readOp: (ref) => Promise.resolve(answers[ref] ?? ''),
    warn: () => {},
  });

  expect(isWritten).toBeFalse();
  expect(existsSync(file)).toBeFalse();
});

test('it writes nothing without op', async () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'tailnet-oauth.json');

  const isWritten = await writeTailnetOAuthFile({
    file,
    env: { IMP_OP_VAULT: 'example' },
    readOp: null,
    warn: () => {},
  });

  expect(isWritten).toBeFalse();
});
