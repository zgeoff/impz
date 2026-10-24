import { createHash } from 'node:crypto';

export interface ContentHash {
  readonly update: (offset: number, data: Uint8Array) => void;
  readonly digest: () => string;
}

export function createContentHash(sizeBytes: number): ContentHash {
  const hash = createHash('sha256').update(`size ${String(sizeBytes)}\n`);

  return {
    update: (offset, data) => {
      if (isAllZero(data)) {
        return;
      }

      const place = new DataView(new ArrayBuffer(16));

      place.setBigUint64(0, BigInt(offset));
      place.setBigUint64(8, BigInt(data.length));
      hash.update(new Uint8Array(place.buffer));
      hash.update(data);
    },
    digest: () => hash.digest('hex'),
  };
}

const ZEROS = Buffer.alloc(64 * 1024);

function isAllZero(data: Uint8Array): boolean {
  for (let start = 0; start < data.length; start += ZEROS.length) {
    const piece = data.subarray(start, start + ZEROS.length);

    if (ZEROS.compare(piece, 0, piece.length, 0, piece.length) !== 0) {
      return false;
    }
  }

  return true;
}
