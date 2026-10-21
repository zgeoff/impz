import { getErrorMessage } from '../../platform/process/get-error-message';
import type { OpenedParts } from './open-move-parts';

interface MovePartsLog {
  readonly log: (message: string) => void;
}

export async function removeMoveParts(deps: MovePartsLog, opened: OpenedParts): Promise<void> {
  try {
    await opened.close();
  } catch (error) {
    deps.log(`impd: move: closing the source's parts failed: ${getErrorMessage(error)}`);
  }
}
