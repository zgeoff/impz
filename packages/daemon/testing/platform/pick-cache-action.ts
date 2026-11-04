export function pickCacheAction(hasTemplate: boolean, copied: boolean): 'build' | 'copy' | 'done' {
  if (copied) {
    return 'done';
  }

  return hasTemplate ? 'copy' : 'build';
}
