import type { Impd } from '@impz/daemon/host/impd/create-impd';
import type { ImageRecord } from '@impz/daemon/host/platform/db/create-image';

type CreateImpInput = Parameters<Impd['imps']['createImp']>[0];

// A test names the image, or leaves it to the default, and the stand-in resolves it as the
// imps.create route does.
export type SeedImpInput = Omit<CreateImpInput, 'image'> & {
  readonly image?: string | ImageRecord | undefined;
};

export type SeedImps<T extends Pick<Impd['imps'], 'createImp'>> = Omit<T, 'createImp'> & {
  readonly createImp: (input: SeedImpInput) => ReturnType<Impd['imps']['createImp']>;
};

export function buildImpsWithResolvedImages<T extends Pick<Impd['imps'], 'createImp'>>(
  imps: T,
  images: Pick<Impd['images'], 'resolveImage'>,
): SeedImps<T> {
  return {
    ...imps,
    createImp: async (input) => {
      const image =
        typeof input.image === 'object' ? input.image : await images.resolveImage(input.image);

      return imps.createImp({ ...input, image });
    },
  };
}
