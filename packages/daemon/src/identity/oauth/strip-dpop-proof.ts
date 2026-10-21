export function stripDpopProof(request: Request): Headers {
  const kept = new Headers(request.headers);

  // the route takes bearer tokens alone, and without the proof better-auth
  // issues a bearer token, as RFC 9449 lets a server do
  kept.delete('dpop');

  return kept;
}
