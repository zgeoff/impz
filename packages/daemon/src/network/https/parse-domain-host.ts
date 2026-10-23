import { NameSchema } from '@impz/api';
import { normalizeHost } from '../proxy/normalize-host';

export type DomainRoute =
  | { readonly kind: 'apex' }
  | { readonly kind: 'imp'; readonly name: string };

export function parseDomainHost(host: string | null, domain: string): DomainRoute | null {
  const hostname = normalizeHost(host);

  if (hostname === null) {
    return null;
  }

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
