// @peculiar/x509 resolves its parts through tsyringe, which needs the
// Reflect metadata API in place before it loads
// oxlint-disable-next-line import/no-unassigned-import -- a polyfill, loaded for its effect
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import type { CertificateInfo } from './renewal-policy';

export function readCertificateInfo(chainPem: string): CertificateInfo {
  const certificate = new x509.X509Certificate(x509.PemConverter.decodeFirst(chainPem));

  const altNames = certificate.getExtension(x509.SubjectAlternativeNameExtension);

  const names = new Set([
    ...certificate.subjectName.getField('CN'),
    ...(altNames?.names.items.map((name) => name.value) ?? []),
  ]);

  names.delete('');

  return { notBefore: certificate.notBefore, notAfter: certificate.notAfter, names: [...names] };
}
