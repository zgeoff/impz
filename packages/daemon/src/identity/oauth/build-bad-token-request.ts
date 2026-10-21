export function buildBadTokenRequest(): Response {
  // better-auth never reads a token or revoke request with no body or one past
  // the form limit, so impd refuses it as RFC 6749 does
  return Response.json(
    { error: 'invalid_request', error_description: 'the request body is missing or too large' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}
