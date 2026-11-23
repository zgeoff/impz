import type { Image } from '@impz/api';
import type { ImageRecord } from '../platform/db/create-image';

export function toApiImage(image: ImageRecord, aliases: readonly string[]): Image {
  return {
    id: image.id,
    name: image.name,
    ref: image.ref,
    digest: image.digest,
    source: image.source,
    createdAt: image.createdAt,
    sizeBytes: image.sizeBytes,
    pinned: image.isPinned,
    aliases: [...aliases],
  };
}
