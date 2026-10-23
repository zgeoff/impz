// oxlint-disable-next-line import/no-unassigned-import -- @peculiar/x509 needs the Reflect metadata API
import 'reflect-metadata';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { createTestCertificates } from './create-test-certificates';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'test-certificates-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it signs a leaf that openssl verifies against the CA for server auth', async () => {
  const ctx = setupTest();

  const certificates = await createTestCertificates({ dnsNames: ['registry.imp.test'] });

  writeFileSync(join(ctx.directoryPath, 'ca.pem'), certificates.caPem);
  writeFileSync(join(ctx.directoryPath, 'leaf.pem'), certificates.certPem);

  const result = Bun.spawnSync(
    ['openssl', 'verify', '-purpose', 'sslserver', '-CAfile', 'ca.pem', 'leaf.pem'],
    { cwd: ctx.directoryPath },
  );

  expect(result.stdout.toString()).toBe('leaf.pem: OK\n');
});

test('it names the leaf by the DNS names and IP addresses it was given', async () => {
  const certificates = await createTestCertificates({
    dnsNames: ['registry.imp.test', 'imp.test'],
    ipAddresses: ['127.0.0.1'],
  });

  const leaf = new x509.X509Certificate(certificates.certPem);

  const names = leaf.getExtension(x509.SubjectAlternativeNameExtension)?.names.toJSON();

  expect(names).toStrictEqual([
    { type: 'dns', value: 'registry.imp.test' },
    { type: 'dns', value: 'imp.test' },
    { type: 'ip', value: '127.0.0.1' },
  ]);
});

test('it gives the leaf the validity window it was given', async () => {
  const notBefore = new Date('2026-03-01T00:00:00Z');
  const notAfter = new Date('2026-03-02T00:00:00Z');

  const certificates = await createTestCertificates({
    dnsNames: ['imp.test'],
    notBefore,
    notAfter,
  });

  const leaf = new x509.X509Certificate(certificates.certPem);

  expect(leaf.notBefore).toStrictEqual(notBefore);
  expect(leaf.notAfter).toStrictEqual(notAfter);
});

test('it makes the leaf valid from before now when no window is given', async () => {
  const certificates = await createTestCertificates({ dnsNames: ['imp.test'] });

  const leaf = new x509.X509Certificate(certificates.certPem);

  expect(leaf.notBefore).toBeBefore(new Date());
  expect(leaf.notAfter).toBeAfter(new Date());
});

test('it gives a key that matches the leaf, and a chain of the leaf then the CA', async () => {
  const ctx = setupTest();

  const certificates = await createTestCertificates({ dnsNames: ['imp.test'] });

  writeFileSync(join(ctx.directoryPath, 'key.pem'), certificates.keyPem);
  writeFileSync(join(ctx.directoryPath, 'leaf.pem'), certificates.certPem);

  const fromKey = Bun.spawnSync(['openssl', 'pkey', '-in', 'key.pem', '-pubout'], {
    cwd: ctx.directoryPath,
  });

  const fromLeaf = Bun.spawnSync(['openssl', 'x509', '-in', 'leaf.pem', '-noout', '-pubkey'], {
    cwd: ctx.directoryPath,
  });

  expect(fromKey.stdout.toString()).toBe(fromLeaf.stdout.toString());
  expect(certificates.chainPem).toBe(`${certificates.certPem}${certificates.caPem}`);
});
