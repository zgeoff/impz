import { randomBytes } from 'node:crypto';

const SECRET_BYTES = 32;

export function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}
