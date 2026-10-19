import { toDigestHex } from '../storage/data-layout';

// Eight characters that tell images apart: a docker ID's first, a template's
// last, since its uuidv7 starts with the time (docs/guides/templates.md)
export function buildDigestTag(digest: string): string {
  if (digest.startsWith('imp-')) {
    return digest.replaceAll('-', '').slice(-8);
  }

  return toDigestHex(digest).slice(0, 8);
}
