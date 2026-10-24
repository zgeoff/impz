import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { OpenedParts } from './open-move-parts';

export async function removeMoveParts(opened: OpenedParts): Promise<void> {
  try {
    await opened.close();
  } catch (error) {
    getImpdLogger('move').warning("closing the source's parts failed: {error}", {
      error: getErrorMessage(error),
    });
  }
}
