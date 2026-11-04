import { isStaleTemplateFile } from './is-stale-template-file';
import type { TemplateFile } from './is-stale-template-file';

export type TemplateStep = 'reuse' | 'build' | 'remove-lock' | 'wait';

export function pickTemplateStep(
  hasTemplate: boolean,
  lock: TemplateFile | null,
  hash: string,
): TemplateStep {
  if (hasTemplate) {
    return 'reuse';
  }

  if (lock === null) {
    return 'build';
  }

  if (isStaleTemplateFile(lock, hash)) {
    return 'remove-lock';
  }

  return 'wait';
}
