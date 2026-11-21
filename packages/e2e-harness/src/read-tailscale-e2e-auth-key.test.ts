import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@zgeoff/testing';
import { createStubBin } from '@zgeoff/testing/bin';
import { probeTailscaleE2EKey, readTailscaleE2EAuthKey } from './read-tailscale-e2e-auth-key';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-tskey-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('#readTailscaleE2EAuthKey reads the e2e client as an ephemeral, preauthorized key with its tag', async () => {
  const found = await readTailscaleE2EAuthKey({ IMP_E2E_TAILSCALE_AUTHKEY: 'fake-client-secret' });

  expect(found).toStrictEqual({
    key: 'fake-client-secret?ephemeral=true&preauthorized=true',
    tags: 'tag:imp-e2e',
  });
});

test('#readTailscaleE2EAuthKey reads no key when neither the env nor op has the e2e client', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'op', { script: '#!/bin/bash\nexit 1' });

  const found = await readTailscaleE2EAuthKey({
    PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
  });

  expect(found).toBeNull();
});

test('#probeTailscaleE2EKey holds for a key with the tag:imp-e2e tag', () => {
  updateEnv('TAILSCALE_AUTHKEY', 'fake-client-secret?ephemeral=true&preauthorized=true');
  updateEnv('IMP_TAILSCALE_TAGS', 'tag:imp-e2e');

  expect(probeTailscaleE2EKey()).toBeTrue();
});

test("#probeTailscaleE2EKey fails for dev's tag:imp key", () => {
  updateEnv('TAILSCALE_AUTHKEY', 'fake-tag-imp-key');
  updateEnv('IMP_TAILSCALE_TAGS', 'tag:imp');

  expect(probeTailscaleE2EKey()).toBeFalse();
});

test('#probeTailscaleE2EKey fails for the e2e tag without a key', () => {
  updateEnv('TAILSCALE_AUTHKEY', undefined);
  updateEnv('IMP_TAILSCALE_TAGS', 'tag:imp-e2e');

  expect(probeTailscaleE2EKey()).toBeFalse();
});
