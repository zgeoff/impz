import { IdentityTrustDocumentSchema } from '@impz/api';
import type { IdentityTrustDocument } from '@impz/api';

// Parses the documents a service pinned. Throws, so the service refuses to
// start, when none is given or two name one issuer: one issuer would then
// name two impds.
export function loadIdentityIssuers(documents: readonly unknown[]): IdentityTrustDocument[] {
  const issuers = documents.map((document) => IdentityTrustDocumentSchema.parse(document));

  checkIdentityIssuers(issuers);

  return issuers;
}

export function checkIdentityIssuers(issuers: readonly IdentityTrustDocument[]): void {
  if (issuers.length === 0) {
    throw new Error('no identity key document is configured');
  }

  const names = issuers.map((document) => document.issuer);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);

  if (repeated !== undefined) {
    throw new Error(`two identity key documents name the issuer ${repeated}`);
  }
}
