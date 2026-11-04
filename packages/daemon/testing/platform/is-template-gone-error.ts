// copyFile reports ENOENT both for a missing source and for a missing
// destination folder, so only the folder's presence says which it was
export function isTemplateGoneError(error: unknown, hasDestinationDirectory: boolean): boolean {
  return (
    hasDestinationDirectory && error instanceof Error && 'code' in error && error.code === 'ENOENT'
  );
}
