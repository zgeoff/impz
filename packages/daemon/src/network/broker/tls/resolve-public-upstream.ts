import type { Upstream } from './forward-request';

export function resolvePublicUpstream(host: string): Upstream {
  return { origin: `https://${host}`, ca: null };
}
