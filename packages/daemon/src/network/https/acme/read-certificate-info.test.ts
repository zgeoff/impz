import { expect, test } from 'bun:test';
import { createTestCertificates } from '@impz/test-utils/create-test-certificates';
import { readCertificateInfo } from './read-certificate-info';

test('it reads the validity and every name of the leaf, once each', async () => {
  const certificates = await createTestCertificates({
    dnsNames: ['imp.test', '*.imp.test'],
    notBefore: new Date('2026-10-01T00:00:00.000Z'),
    notAfter: new Date('2026-12-30T00:00:00.000Z'),
  });

  expect(readCertificateInfo(certificates.chainPem)).toStrictEqual({
    notBefore: new Date('2026-10-01T00:00:00.000Z'),
    notAfter: new Date('2026-12-30T00:00:00.000Z'),
    names: ['imp.test', '*.imp.test'],
  });
});

test('it refuses text that holds no certificate', () => {
  expect(() => readCertificateInfo('not a certificate')).toThrow();
});
