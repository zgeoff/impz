// A browser names the page a request comes from in Sec-Fetch-Site or
// Origin; on the public route only the route's own origin may call
export function isPublicCrossOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  const from = request.headers.get('origin');

  if (site === null && from === null) {
    return false;
  }

  return from !== origin || (site !== null && site !== 'same-origin');
}
