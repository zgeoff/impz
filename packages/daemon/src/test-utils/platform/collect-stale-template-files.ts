import { isStaleTemplateFile } from './is-stale-template-file';
import type { TemplateFile } from './is-stale-template-file';

export function collectStaleTemplateFiles(
  files: readonly TemplateFile[],
  hash: string,
): TemplateFile[] {
  return files.filter((file) => isStaleTemplateFile(file, hash));
}
