export function isMissingHostAddresses(
  hasPublic: boolean,
  hostAddresses: readonly string[],
): boolean {
  return hasPublic && hostAddresses.length === 0;
}
