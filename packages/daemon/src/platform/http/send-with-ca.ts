export type CaRequestInit = Omit<RequestInit, 'tls'> & {
  readonly tls?: { readonly ca: readonly string[] };
};

export function sendWithCa(url: string, init: Readonly<CaRequestInit>): Promise<Response> {
  const tls = init.tls === undefined ? {} : { tls: { ca: [...init.tls.ca] } };

  return fetch(url, { ...init, ...tls });
}
