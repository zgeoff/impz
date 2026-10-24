import type { DnsConfig } from '../https-config';
import { createChalltestsrvProvider } from './challtestsrv-provider';
import { createCloudflareProvider } from './cloudflare-provider';
import type { DnsProvider } from './dns-provider';
import type { DnsToken } from './dns-token';

export function createDnsProvider(config: DnsConfig, token: DnsToken | null): DnsProvider {
  if (config.provider === 'challtestsrv') {
    return createChalltestsrvProvider(config.apiUrl ?? '');
  }

  if (token === null) {
    throw new Error('IMP_DNS_PROVIDER=cloudflare needs a token');
  }

  return createCloudflareProvider({
    readToken: token.read,
    ...(config.apiUrl !== null && { apiUrl: config.apiUrl }),
  });
}
