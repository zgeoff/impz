export interface OpaqueToken {
  readonly id: string;
  readonly secret: string;
}

export function parseOpaqueToken(prefix: string, text: string): OpaqueToken | null {
  if (!text.startsWith(prefix)) {
    return null;
  }

  const [id, secret, ...rest] = text.slice(prefix.length).split('.');

  return id === undefined || id === '' || secret === undefined || secret === '' || rest.length > 0
    ? null
    : { id, secret };
}
