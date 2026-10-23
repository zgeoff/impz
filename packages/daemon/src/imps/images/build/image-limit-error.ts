import { ImpdError } from '../../../platform/errors/impd-error';

export class ImageLimitError extends ImpdError<'BAD_REQUEST'> {
  override readonly name = 'ImageLimitError';

  constructor(limit: 'bytes' | 'files', max: number) {
    const over =
      limit === 'bytes'
        ? `over ${String(Math.floor(max / 1024 ** 2))} MiB (IMP_BUILD_IMAGE_MAX_MIB)`
        : `over ${String(max)} files (IMP_BUILD_IMAGE_MAX_FILES)`;

    super('BAD_REQUEST', { message: `the built image's filesystem is ${over}` });
  }
}
