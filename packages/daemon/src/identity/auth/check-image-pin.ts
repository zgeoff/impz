import { isImpAllowed } from '@impz/api';
import { formatCaller } from '../../platform/principal/caller';
import type { Caller } from '../../platform/principal/caller';
import type { ReadImage, Refusal } from './access-policy';

export async function checkImagePin(
  caller: Readonly<Caller>,
  patterns: readonly string[],
  name: string | null,
  readImage: ReadImage,
): Promise<Refusal | null> {
  const who = formatCaller(caller);
  const prefix = caller.imageRefPrefix;

  if (prefix === null) {
    return { message: `${who} is limited to some imps; this call is host-wide`, reason: null };
  }

  if (name === null) {
    return {
      message: `${who} is limited to some imps, so the call must name the image (name)`,
      reason: 'imp_out_of_scope',
    };
  }

  if (!isImpAllowed(patterns, name)) {
    return { message: `${who} may not pin or unpin image ${name}`, reason: 'imp_out_of_scope' };
  }

  const image = await readImage(name);

  if (image === undefined) {
    return null;
  }

  if (!image.ref.startsWith(prefix)) {
    return {
      message: `${who} may pin or unpin only images whose ref starts with ${prefix}`,
      reason: null,
    };
  }

  return null;
}
