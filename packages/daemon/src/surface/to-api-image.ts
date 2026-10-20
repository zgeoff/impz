import type { Image } from '@impz/api';
import type { ImageRecord } from '../platform/db/images';

export function toApiImage(image: ImageRecord): Image {
  return {
    id: image.id,
    name: image.name,
    ref: image.ref,
    digest: image.digest,
    source: image.source,
    createdAt: image.createdAt,
    sizeBytes: image.sizeBytes,
  };
}
