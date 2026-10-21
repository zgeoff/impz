import { NameSchema } from '@impz/api';

export type DomainRoute =
  | { readonly kind: 'apex' }
  | { readonly kind: 'imp'; readonly name: string };

export function parseDomainHost(host: string | null, domain: string): DomainRoute | null {
  if (host === null || host.startsWith('[')) {
    return null;
  }

  const hostname = host.replace(/:\d+$/u, '').replace(/\.$/u, '').toLowerCase();

  if (hostname === domain) {
    return { kind: 'apex' };
  }

  if (!hostname.endsWith(`.${domain}`)) {
    return null;
  }

  const label = hostname.slice(0, -(domain.length + 1));
  const parsed = NameSchema.safeParse(label);

  return parsed.success && !label.includes('.') ? { kind: 'imp', name: parsed.data } : null;
}
