export function isSameOriginForm(request: Request, origin: string): boolean {
  const from = request.headers.get('origin');

  if (from === origin) {
    return true;
  }

  // a browser sets Sec-Fetch-Site itself, and no page can change it
  return from === 'null' && request.headers.get('sec-fetch-site') === 'same-origin';
}
