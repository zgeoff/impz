// A form a page on another origin posts never counts. A browser names the
// page's origin, or sends Origin null with Sec-Fetch-Site, which it sets
// itself and no page can change.
export function isSameOriginForm(request: Request, origin: string): boolean {
  const from = request.headers.get('origin');

  if (from === origin) {
    return true;
  }

  return from === 'null' && request.headers.get('sec-fetch-site') === 'same-origin';
}
