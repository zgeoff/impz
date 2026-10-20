// The route takes bearer tokens alone, so a client's DPoP proof is dropped
// and better-auth issues a bearer token, as RFC 9449 lets a server do.
export function stripDpopProof(request: Request): Headers {
  const kept = new Headers(request.headers);

  kept.delete('dpop');

  return kept;
}
