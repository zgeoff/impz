import { NameSchema } from '@impz/api';
import { normalizeHost } from './normalize-host';

export function parseHostName(host: string | null): string | null {
  const hostname = normalizeHost(host);

  if (hostname === null) {
    return null;
  }

  const labels = hostname.split('.');

  if (labels.length < 2 || /^[\d.]+$/u.test(hostname)) {
    return null;
  }

  const parsed = NameSchema.safeParse(labels[0]);

  return parsed.success ? parsed.data : null;
}
