import type { Upstream } from './create-forwarder';

export function resolvePublicUpstream(host: string): Upstream {
  return { origin: `https://${host}`, ca: null };
}
