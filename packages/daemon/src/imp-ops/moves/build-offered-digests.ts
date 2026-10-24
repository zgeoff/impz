export function buildOfferedDigests(digest: string, receivedDigest: string | null): string[] {
  return receivedDigest === null ? [digest] : [digest, receivedDigest];
}
