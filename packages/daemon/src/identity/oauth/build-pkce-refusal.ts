export function buildPkceRefusal(): Response {
  return Response.json(
    { error: 'invalid_grant', error_description: 'code verification failed' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}
