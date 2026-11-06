// copyFile reports ENOENT for a missing source, a missing destination folder
// and a destination link to a missing path, so only the template's own
// absence says that a sweep removed it
export function isTemplateGoneError(error: unknown, hasTemplate: boolean): boolean {
  return !hasTemplate && error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
