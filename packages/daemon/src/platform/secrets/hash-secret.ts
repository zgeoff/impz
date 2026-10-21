import { createHash } from 'node:crypto';

// a fast hash suits only a secret impd draws at random; a secret a person
// picks needs a slow one
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}
