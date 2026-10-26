import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildPebbleEnv } from './pebble';

test('#buildPebbleEnv points the instance at the stack named after its container', () => {
  const repoRoot = join(import.meta.dir, '..', '..', '..');

  expect(buildPebbleEnv('imp-wt')).toStrictEqual({
    IMP_DEV_NETWORK: 'imp-wt-acme',
    IMP_E2E: '1',
    IMP_DOMAIN: 'imp.test',
    IMP_DNS_PROVIDER: 'challtestsrv',
    IMP_DNS_API_URL: 'http://challtestsrv:8055',
    IMP_ACME_DIRECTORY: 'https://pebble:14000/dir',
    IMP_ACME_CA_FILE: join(repoRoot, '.cache', 'e2e', 'imp-wt-pebble-minica.pem'),
    IMP_PUBLIC_IP: '203.0.113.7',
  });
});
