import { hashSecret } from '../../platform/secrets/hash-secret';

export function deriveTokenHash(token: string): string {
  return hashSecret(token).toString('base64url');
}
