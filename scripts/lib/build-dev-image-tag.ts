import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const TAG_BYTE = /[A-Za-z0-9_.-]/u;
const NAME_MAX_BYTES = 40;

// Each byte outside Docker's tag characters becomes one dash, so a checkout keeps the tag that the
// byte-wise bash replacement gave it, and its existing image stays its own.
export function buildDevImageTag(root: string): string {
  const name = [...Buffer.from(basename(root), 'utf8')]
    .map((byte) =>
      byte < 0x80 && TAG_BYTE.test(String.fromCodePoint(byte)) ? String.fromCodePoint(byte) : '-',
    )
    .join('')
    .slice(0, NAME_MAX_BYTES);

  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);

  return `imp-host:dev-${name}-${hash}`;
}
