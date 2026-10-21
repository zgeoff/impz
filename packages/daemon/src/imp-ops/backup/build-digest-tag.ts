import { toDigestHex } from '../../vm/storage/data-layout';

export function buildDigestTag(digest: string): string {
  if (digest.startsWith('imp-')) {
    // A uuidv7 starts with the time, so its last characters tell templates apart.
    return digest.replaceAll('-', '').slice(-8);
  }

  return toDigestHex(digest).slice(0, 8);
}
