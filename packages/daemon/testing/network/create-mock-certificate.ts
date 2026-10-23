import { faker } from '@faker-js/faker';
import { createTestCertificates } from '@impz/test-utils/create-test-certificates';
import type { Certificate } from '../../src/network/https/acme/cert-store';

interface MockCertificateOptions {
  readonly names: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export async function createMockCertificate(
  overrides: Partial<MockCertificateOptions> = {},
): Promise<Certificate> {
  const notBefore = overrides.notBefore ?? new Date(Date.now() - 60_000);

  const certificates = await createTestCertificates({
    dnsNames: overrides.names ?? [faker.internet.domainName()],
    notBefore,
    notAfter: overrides.notAfter ?? new Date(notBefore.getTime() + 86_400_000),
  });

  return { keyPem: certificates.keyPem, chainPem: certificates.chainPem };
}
