import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockCertificate } from '../../test-utils/create-mock-certificate';
import { createCertStore } from './cert-store';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-certs-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it reads no certificate before one is written', async () => {
  const ctx = await setupTest();

  expect(createCertStore(ctx.directoryPath).readCertificate()).toBeNull();
});

test('it gives back a written certificate and its key', async () => {
  const ctx = await setupTest();

  const store = createCertStore(ctx.directoryPath);

  const certificate = await createMockCertificate({ names: ['imp.test', '*.imp.test'] });

  store.writeCertificate(certificate);

  expect(createCertStore(ctx.directoryPath).readCertificate()).toStrictEqual({
    keyPem: certificate.keyPem.trimEnd(),
    chainPem: certificate.chainPem.trimEnd(),
  });
});

test('it writes the certificate readable by root only', async () => {
  const ctx = await setupTest();

  const store = createCertStore(ctx.directoryPath);

  const certificate = await createMockCertificate();

  store.writeCertificate(certificate);

  expect(statSync(join(ctx.directoryPath, 'tls', 'certificate.pem')).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.directoryPath, 'tls')).mode & 0o777).toBe(0o700);
});

test('it keeps every certificate of a chain in order', async () => {
  const ctx = await setupTest();

  const store = createCertStore(ctx.directoryPath);

  const leaf = await createMockCertificate({ names: ['imp.test'] });
  const issuer = await createMockCertificate({ names: ['ca.test'] });

  store.writeCertificate({ keyPem: leaf.keyPem, chainPem: `${leaf.chainPem}\n${issuer.chainPem}` });

  expect(store.readCertificate()?.chainPem).toBe(
    `${leaf.chainPem.trimEnd()}\n${issuer.chainPem.trimEnd()}`,
  );
});

test('it reads a certificate file with no key as no certificate', async () => {
  const ctx = await setupTest();
  const certificate = await createMockCertificate();

  await mkdir(join(ctx.directoryPath, 'tls'));
  await writeFile(join(ctx.directoryPath, 'tls', 'certificate.pem'), certificate.chainPem);

  expect(createCertStore(ctx.directoryPath).readCertificate()).toBeNull();
});

test('it reads a certificate file with no certificate as no certificate', async () => {
  const ctx = await setupTest();
  const certificate = await createMockCertificate();

  await mkdir(join(ctx.directoryPath, 'tls'));
  await writeFile(join(ctx.directoryPath, 'tls', 'certificate.pem'), certificate.keyPem);

  expect(createCertStore(ctx.directoryPath).readCertificate()).toBeNull();
});

test('it reads no attempts before any are written', async () => {
  const ctx = await setupTest();

  expect(createCertStore(ctx.directoryPath).readAttempts()).toStrictEqual({
    failures: 0,
    lastAttemptAt: null,
    lastError: null,
  });
});

test('it keeps the attempts across a restart', async () => {
  const ctx = await setupTest();

  createCertStore(ctx.directoryPath).writeAttempts({
    failures: 2,
    lastAttemptAt: 1000,
    lastError: 'boom',
  });

  expect(createCertStore(ctx.directoryPath).readAttempts()).toStrictEqual({
    failures: 2,
    lastAttemptAt: 1000,
    lastError: 'boom',
  });
});

test('it reads a damaged attempts file as no attempts', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'tls'));
  await writeFile(join(ctx.directoryPath, 'tls', 'attempts.json'), '{not json');

  expect(createCertStore(ctx.directoryPath).readAttempts()).toStrictEqual({
    failures: 0,
    lastAttemptAt: null,
    lastError: null,
  });
});

test('it reads no account before one is written', async () => {
  const ctx = await setupTest();

  expect(createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir')).toBeNull();
});

test('it keeps the account, its key and URL together, across a restart', async () => {
  const ctx = await setupTest();

  createCertStore(ctx.directoryPath).writeAccount({
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  });

  expect(createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir')).toStrictEqual({
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  });
});

test('it reads no account for another ACME directory', async () => {
  const ctx = await setupTest();

  const store = createCertStore(ctx.directoryPath);

  store.writeAccount({
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  });

  expect(store.readAccount('https://other.test/dir')).toBeNull();
});

test('it writes the account readable by root only', async () => {
  const ctx = await setupTest();

  createCertStore(ctx.directoryPath).writeAccount({
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  });

  expect(statSync(join(ctx.directoryPath, 'tls', 'account.json')).mode & 0o777).toBe(0o600);
});

test('it makes the v0.1.1 key and URL at the same directory one account', async () => {
  const ctx = await setupTest();

  // v0.1.1's layout: the key in account.key, the URL alone in account.json
  await mkdir(join(ctx.directoryPath, 'tls'));

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.key'),
    '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  );

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.json'),
    JSON.stringify({ directoryUrl: 'https://ca.test/dir', url: 'https://ca.test/acct/1' }),
  );

  const account = createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir');

  expect(account).toStrictEqual({
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  });

  expect(existsSync(join(ctx.directoryPath, 'tls', 'account.key'))).toBeFalse();
  expect(statSync(join(ctx.directoryPath, 'tls', 'account.json')).mode & 0o777).toBe(0o600);
});

test('it reads a v0.1.1 account back from the one file once its key file is gone', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'tls'));

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.key'),
    '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  );

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.json'),
    JSON.stringify({ directoryUrl: 'https://ca.test/dir', url: 'https://ca.test/acct/1' }),
  );

  createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir');

  expect(createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir')).toStrictEqual({
    directoryUrl: 'https://ca.test/dir',
    url: 'https://ca.test/acct/1',
    keyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  });
});

test('it drops a v0.1.1 key for another directory', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'tls'));

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.key'),
    '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  );

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.json'),
    JSON.stringify({ directoryUrl: 'https://old.test/dir', url: 'https://old.test/acct/1' }),
  );

  const account = createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir');

  expect(account).toBeNull();
  expect(existsSync(join(ctx.directoryPath, 'tls', 'account.key'))).toBeFalse();
});

test('it drops a v0.1.1 key that has no URL', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'tls'));

  await writeFile(
    join(ctx.directoryPath, 'tls', 'account.key'),
    '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n',
  );

  const account = createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir');

  expect(account).toBeNull();
  expect(existsSync(join(ctx.directoryPath, 'tls', 'account.key'))).toBeFalse();
});

test('it logs an account file that does not parse once', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();
  const store = createCertStore(ctx.directoryPath, log);

  await mkdir(join(ctx.directoryPath, 'tls'));
  await writeFile(join(ctx.directoryPath, 'tls', 'account.json'), '{"directoryUrl":');

  store.readAccount('https://ca.test/dir');
  store.readAccount('https://ca.test/dir');

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `impd: https: ${join(ctx.directoryPath, 'tls', 'account.json')} does not parse; making a new ACME account`,
  );
});

test('it reads no account from an account file that does not parse', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'tls'));
  await writeFile(join(ctx.directoryPath, 'tls', 'account.json'), '{"directoryUrl":');

  expect(createCertStore(ctx.directoryPath).readAccount('https://ca.test/dir')).toBeNull();
});
