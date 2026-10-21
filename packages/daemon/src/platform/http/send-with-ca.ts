export type CARequestInit = Omit<RequestInit, 'tls'> & {
  readonly tls?: { readonly ca: readonly string[] };
};

export function sendWithCA(url: string, init: Readonly<CARequestInit>): Promise<Response> {
  const tls = init.tls === undefined ? {} : { tls: { ca: [...init.tls.ca] } };

  return fetch(url, { ...init, ...tls });
}
