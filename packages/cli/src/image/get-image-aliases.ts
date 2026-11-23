import type { Image } from '@impz/api';

// The client does not check answers, and an impd older than image aliases sends none.
export function getImageAliases(
  image: Readonly<Partial<Pick<Image, 'aliases'>>>,
): readonly string[] {
  return image.aliases ?? [];
}
