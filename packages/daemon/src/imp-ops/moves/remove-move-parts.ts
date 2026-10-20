import { readErrorMessage } from '../../platform/process/read-error-message';
import type { OpenedParts } from './open-move-parts';

interface MovePartsLog {
  readonly log: (message: string) => void;
}

// A close that fails leaves the move snapshot to the GC: logged, so it
// never hides the error the send itself ended with
export async function removeMoveParts(deps: MovePartsLog, opened: OpenedParts): Promise<void> {
  try {
    await opened.close();
  } catch (error) {
    deps.log(`impd: move: closing the source's parts failed: ${readErrorMessage(error)}`);
  }
}
