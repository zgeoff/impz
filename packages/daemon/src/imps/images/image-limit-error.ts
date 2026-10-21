// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';

export class ImageLimitError extends ORPCError<'BAD_REQUEST', undefined> {
  override readonly name = 'ImageLimitError';

  constructor(limit: 'bytes' | 'files', max: number) {
    const over =
      limit === 'bytes'
        ? `over ${String(Math.floor(max / 1024 ** 2))} MiB (IMP_BUILD_IMAGE_MAX_MIB)`
        : `over ${String(max)} files (IMP_BUILD_IMAGE_MAX_FILES)`;

    super('BAD_REQUEST', { message: `the built image's filesystem is ${over}` });
  }
}
