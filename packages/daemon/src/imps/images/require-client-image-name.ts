import { NameSchema } from '@impz/api';
import { ImpdError } from '../../platform/errors/impd-error';
import { BUILDER_IMAGE } from './builders/builder-imps';

export function requireClientImageName(name: string): string {
  const imageName = NameSchema.parse(name);

  if (imageName === BUILDER_IMAGE) {
    throw new ImpdError('BAD_REQUEST', {
      message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
    });
  }

  return imageName;
}
