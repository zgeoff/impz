import { NameSchema } from '@impz/api';

export function parseHostName(host: string | null): string | null {
  if (host === null || host.startsWith('[')) {
    return null;
  }

  const hostname = host.replace(/:\d+$/u, '').replace(/\.$/u, '').toLowerCase();
  const labels = hostname.split('.');

  if (labels.length < 2 || /^[\d.]+$/u.test(hostname)) {
    return null;
  }

  const parsed = NameSchema.safeParse(labels[0]);

  return parsed.success ? parsed.data : null;
}
