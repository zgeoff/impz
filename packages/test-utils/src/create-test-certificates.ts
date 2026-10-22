// @peculiar/x509 resolves its parts through tsyringe, which needs the
// Reflect metadata API in place before it loads
// oxlint-disable-next-line import/no-unassigned-import -- a polyfill, loaded for its effect
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface TestCertificatesOptions {
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export interface TestCertificates {
  readonly caPem: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly chainPem: string;
}

export async function createTestCertificates(
  options: Readonly<TestCertificatesOptions> = {},
): Promise<TestCertificates> {
  const dnsNames = options.dnsNames ?? [];
  const ipAddresses = options.ipAddresses ?? [];
  const notBefore = options.notBefore ?? new Date(Date.now() - HOUR_MS);
  const notAfter = options.notAfter ?? new Date(notBefore.getTime() + 2 * DAY_MS);
  const commonName = dnsNames[0] ?? ipAddresses[0] ?? 'test';

  const caKeys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const leafKeys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: buildSerialNumber(),
    name: 'CN=imp test CA',
    notBefore,
    notAfter,
    keys: caKeys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: buildSerialNumber(),
    subject: `CN=${commonName}`,
    issuer: ca.subject,
    notBefore,
    notAfter,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        ...dnsNames.map((name) => ({ type: 'dns' as const, value: name })),
        ...ipAddresses.map((address) => ({ type: 'ip' as const, value: address })),
      ]),
      await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', leafKeys.privateKey);

  const caPem = `${ca.toString('pem').trimEnd()}\n`;
  const certPem = `${leaf.toString('pem').trimEnd()}\n`;

  return {
    caPem,
    certPem,
    keyPem: `${x509.PemConverter.encode(pkcs8, 'PRIVATE KEY').trimEnd()}\n`,
    chainPem: `${certPem}${caPem}`,
  };
}

function buildSerialNumber(): string {
  // a leading 0 bit keeps the DER integer positive
  return `0${crypto.randomUUID().replaceAll('-', '').slice(1)}`;
}
