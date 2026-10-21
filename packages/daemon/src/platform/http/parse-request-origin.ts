export interface RequestOrigin {
  readonly fromBrowser: boolean;
  readonly site: string | null;
  readonly origin: string | null;
}

// A browser sets Sec-Fetch-Site itself, and no page can change it. A client
// that is no browser sends neither header.
export function parseRequestOrigin(request: Request): RequestOrigin {
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');

  return { fromBrowser: site !== null || origin !== null, site, origin };
}
