import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { createDnsToken } from './dns/dns-token';
import { wireHttpsService } from './wire-https-service';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-wire-https-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const database = await createTestDatabase();

  return { directoryPath: directory, db: database.db };
}

test('it says at start that DNS records and certificates wait for a DNS token file it cannot read', async () => {
  const ctx = await setupTest();

  const tokenPath = join(ctx.directoryPath, 'dns-api-token');

  const service = wireHttpsService({
    config: {
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      dns: { provider: 'cloudflare', token: { kind: 'file', path: tokenPath }, apiUrl: null },
      acmeDirectory: 'http://127.0.0.1:1/directory',
      acmeEmail: null,
      acmeCaFile: null,
      public: null,
    },
    dataDir: ctx.directoryPath,
    db: ctx.db,
    proxy: {
      startListener: () => {
        throw new Error('no certificate arrives, so no listener starts');
      },
    },
    readTailscale: null,
    dnsToken: createDnsToken({ kind: 'file', path: tokenPath }, Date.now),
  });

  onTestFinished(() => service.stop());

  const logs = captureImpdLogs();

  service.start();

  await waitFor(() => {
    expect(logs).toContain(
      `WARNING impd.https cannot read the DNS API token from ${tokenPath}: ENOENT; DNS records and certificates wait until it holds a token`,
    );
  });
});
