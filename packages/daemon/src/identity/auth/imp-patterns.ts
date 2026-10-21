export function toLikePattern(pattern: string): string {
  // imp patterns allow no `%` or `_`, so `*` is the only character to rewrite
  return pattern.replaceAll('*', '%');
}
