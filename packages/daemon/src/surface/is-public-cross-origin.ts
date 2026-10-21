export function isPublicCrossOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  const from = request.headers.get('origin');

  // A browser sends Sec-Fetch-Site or Origin, and a client that is no browser
  // sends neither.
  if (site === null && from === null) {
    return false;
  }

  return from !== origin || (site !== null && site !== 'same-origin');
}
