import { faker } from '@faker-js/faker';
import type { TokenSshKeyRecord } from '../../src/db/tokens';
import { formatKeyFingerprint } from '../../src/ssh/authorized-keys';
import { generateEd25519Key } from '../../src/ssh/host-key';

// An SSH key bound to a token, as the token store writes its row: a fresh
// ed25519 key under a fresh token id, with an arbitrary comment and age.
export function buildMockTokenSshKeyRecord(
  overrides: Partial<TokenSshKeyRecord> = {},
): TokenSshKeyRecord {
  const publicKey = generateEd25519Key().public;
  const blob = Buffer.from(publicKey.split(' ')[1] ?? '', 'base64');

  return {
    id: faker.string.alphanumeric(16),
    tokenId: faker.string.alphanumeric(16),
    fingerprint: formatKeyFingerprint(blob),
    publicKey,
    comment: faker.internet.email(),
    createdAt: faker.date.past(),
    ...overrides,
  };
}
