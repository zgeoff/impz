import { readFileSync, statSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import * as z from 'zod';
import type { ResolveUpstream } from './network/broker/tls/forward-request';
import { resolvePublicUpstream } from './network/broker/tls/resolve-public-upstream';
import { getErrorMessage } from './platform/process/get-error-message';

const FileSchema = z.object({
  ca: z.string().includes('-----BEGIN CERTIFICATE-----'),
  upstreams: z.record(z.string(), z.url({ protocol: /^https$/u })),
});

export function createUpstreamResolver(
  path: string,
  log: (message: string) => void,
): ResolveUpstream {
  const cache: { mtimeMs: number; file: z.infer<typeof FileSchema> | null } = {
    mtimeMs: -1,
    file: null,
  };

  const readFile = (): z.infer<typeof FileSchema> | null => {
    let mtimeMs: number;

    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      cache.mtimeMs = -1;
      cache.file = null;

      return null;
    }

    if (mtimeMs !== cache.mtimeMs) {
      cache.mtimeMs = mtimeMs;

      try {
        cache.file = FileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

        const hosts = Object.keys(cache.file.upstreams).join(', ');

        log(`impd: broker: warning: test upstreams from ${path} stand in for ${hosts}`);
      } catch (error) {
        cache.file = null;

        log(`impd: broker: ignoring ${path}: ${getErrorMessage(error)}`);
      }
    }

    return cache.file;
  };

  return (host) => {
    const file = readFile();
    const origin = file?.upstreams[host];

    if (file === null || origin === undefined) {
      return resolvePublicUpstream(host);
    }

    return { origin: origin.replace(/\/$/u, ''), ca: [...rootCertificates, file.ca] };
  };
}
