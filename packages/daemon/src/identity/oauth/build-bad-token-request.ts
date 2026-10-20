// RFC 6749's refusal of a token or revoke request with no body, or one past
// MAX_FORM_BYTES, which better-auth never reads
export function buildBadTokenRequest(): Response {
  return Response.json(
    { error: 'invalid_request', error_description: 'the request body is missing or too large' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}
