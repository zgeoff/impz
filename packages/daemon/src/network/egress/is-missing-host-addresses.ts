// The Docker host's own networks, missing for a public imp: IMP_HOST_ADDRESSES
// is empty, whatever IMP_EGRESS_DENY holds (it always holds IMP_PUBLIC_IP).
export function isMissingHostAddresses(
  hasPublic: boolean,
  hostAddresses: readonly string[],
): boolean {
  return hasPublic && hostAddresses.length === 0;
}
