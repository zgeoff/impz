import { faker } from '@faker-js/faker';
import { formatKeyFingerprint } from '../../imps/ssh/authorized-keys';
import type { TokenSshKeyRecord } from '../../platform/db/tokens';
import { generateEd25519Key } from '../../surface/ssh/host-key';

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
