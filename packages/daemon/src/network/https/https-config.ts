import { existsSync } from 'node:fs';
import * as z from 'zod';
import type { DnsTokenSource } from './dns/dns-token';

const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

const DomainSchema = z
  .string()
  .transform((value) => value.toLowerCase().replace(/\.$/u, ''))
  .pipe(
    z
      .string()
      .regex(
        /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u,
        'IMP_DOMAIN must be a domain name such as imp.example.com',
      ),
  );

const PortSchema = z.coerce.number().pipe(z.int().min(1).max(65_535));
const DNS_PROVIDERS = ['cloudflare', 'challtestsrv'] as const;

type DnsProviderKind = (typeof DNS_PROVIDERS)[number];

export const HttpsEnvSchema = z.object({
  IMP_DOMAIN: DomainSchema.optional(),
  IMP_HTTPS_PORT: PortSchema.default(443),
  IMP_HTTP_PORT: PortSchema.default(80),
  IMP_DNS_PROVIDER: z.enum(DNS_PROVIDERS).optional(),
  IMP_DNS_API_TOKEN: z.string().optional(),

  IMP_DNS_API_TOKEN_FILE: z.string().optional(),
  IMP_DNS_API_URL: z.url().optional(),
  IMP_ACME_DIRECTORY: z.url().default(LETS_ENCRYPT_DIRECTORY),
  IMP_ACME_EMAIL: z.email().optional(),
  IMP_ACME_CA_FILE: z.string().optional(),

  IMP_PUBLIC_IP: z.ipv4().optional(),
  IMP_PUBLIC_HTTPS_PORT: PortSchema.default(7443),
  IMP_PUBLIC_HTTP_PORT: PortSchema.default(7480),

  IMP_E2E: z.literal('1').optional(),
});

export interface DnsConfig {
  readonly provider: DnsProviderKind;

  readonly token: DnsTokenSource | null;

  readonly apiUrl: string | null;
}

interface PublicConfig {
  readonly ip: string;
  readonly httpsPort: number;
  readonly httpPort: number;
}

export interface HttpsConfig {
  readonly domain: string;
  readonly httpsPort: number;
  readonly httpPort: number;
  readonly dns: DnsConfig;
  readonly acmeDirectory: string;
  readonly acmeEmail: string | null;

  readonly acmeCaFile: string | null;

  readonly public: PublicConfig | null;
}

export function readHttpsConfig(env: z.infer<typeof HttpsEnvSchema>): HttpsConfig | null {
  if (env.IMP_DNS_API_TOKEN !== undefined && env.IMP_DNS_API_TOKEN_FILE !== undefined) {
    throw new Error('set IMP_DNS_API_TOKEN or IMP_DNS_API_TOKEN_FILE, not both');
  }

  if (env.IMP_DOMAIN === undefined) {
    if (env.IMP_PUBLIC_IP !== undefined) {
      throw new Error('IMP_PUBLIC_IP needs IMP_DOMAIN: public imps are served on it');
    }

    return null;
  }

  if (env.IMP_DNS_PROVIDER === undefined) {
    throw new Error(
      `IMP_DOMAIN needs IMP_DNS_PROVIDER (${DNS_PROVIDERS.join(' or ')}) for its certificate`,
    );
  }

  const token = findTokenSource(env);

  if (env.IMP_DNS_PROVIDER === 'cloudflare' && token === null) {
    throw new Error(
      'IMP_DNS_PROVIDER=cloudflare needs IMP_DNS_API_TOKEN or IMP_DNS_API_TOKEN_FILE',
    );
  }

  if (env.IMP_DNS_PROVIDER === 'challtestsrv') {
    checkTestProvider(env);
  }

  if (env.IMP_DNS_PROVIDER === 'cloudflare' && env.IMP_DNS_API_URL !== undefined) {
    checkSecureUrl(env.IMP_DNS_API_URL);
  }

  if (env.IMP_ACME_CA_FILE !== undefined && !existsSync(env.IMP_ACME_CA_FILE)) {
    throw new Error(`IMP_ACME_CA_FILE ${env.IMP_ACME_CA_FILE} does not exist`);
  }

  if (env.IMP_HTTPS_PORT === env.IMP_HTTP_PORT) {
    throw new Error('IMP_HTTPS_PORT and IMP_HTTP_PORT must differ');
  }

  return {
    domain: env.IMP_DOMAIN,
    httpsPort: env.IMP_HTTPS_PORT,
    httpPort: env.IMP_HTTP_PORT,
    dns: {
      provider: env.IMP_DNS_PROVIDER,
      token,
      apiUrl: env.IMP_DNS_API_URL ?? null,
    },
    acmeDirectory: env.IMP_ACME_DIRECTORY,
    acmeEmail: env.IMP_ACME_EMAIL ?? null,
    acmeCaFile: env.IMP_ACME_CA_FILE ?? null,
    public:
      env.IMP_PUBLIC_IP === undefined
        ? null
        : {
            ip: env.IMP_PUBLIC_IP,
            httpsPort: env.IMP_PUBLIC_HTTPS_PORT,
            httpPort: env.IMP_PUBLIC_HTTP_PORT,
          },
  };
}

const UNREACHABLE_RANGES: readonly (readonly [number, number, number])[] = [
  [10, 0, 255],
  [100, 64, 127],
  [127, 0, 255],
  [169, 254, 254],
  [172, 16, 31],
  [192, 168, 168],
];

export function listHttpsWarnings(env: z.infer<typeof HttpsEnvSchema>): string[] {
  const warnings: string[] = [];

  if (env.IMP_DOMAIN === undefined && env.IMP_DNS_API_TOKEN_FILE !== undefined) {
    warnings.push(
      'IMP_DNS_API_TOKEN_FILE is set without IMP_DOMAIN; HTTPS is off and the file is unused',
    );
  }

  if (env.IMP_PUBLIC_IP !== undefined && isUnreachable(env.IMP_PUBLIC_IP)) {
    warnings.push(
      `IMP_PUBLIC_IP ${env.IMP_PUBLIC_IP} is not an internet address; public imps' records point at it, so the internet cannot reach them`,
    );
  }

  return warnings;
}

function isUnreachable(ip: string): boolean {
  const [first = 0, second = 0] = ip.split('.').map(Number);

  return UNREACHABLE_RANGES.some(
    ([octet, from, to]) => first === octet && second >= from && second <= to,
  );
}

function findTokenSource(env: z.infer<typeof HttpsEnvSchema>): DnsTokenSource | null {
  if (env.IMP_DNS_API_TOKEN_FILE !== undefined) {
    return { kind: 'file', path: env.IMP_DNS_API_TOKEN_FILE };
  }

  if (env.IMP_DNS_API_TOKEN !== undefined) {
    return { kind: 'value', value: env.IMP_DNS_API_TOKEN };
  }

  return null;
}

// challtestsrv answers every lookup Pebble makes and none a real CA makes
function checkTestProvider(env: z.infer<typeof HttpsEnvSchema>): void {
  if (env.IMP_E2E !== '1') {
    throw new Error('IMP_DNS_PROVIDER=challtestsrv is for tests only and needs IMP_E2E=1');
  }

  if (env.IMP_DNS_API_URL === undefined) {
    throw new Error('IMP_DNS_PROVIDER=challtestsrv needs IMP_DNS_API_URL, its management API');
  }
}

function checkSecureUrl(url: string): void {
  const parsed = new URL(url);

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);

  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error(`IMP_DNS_API_URL must be https, unless it is on loopback: ${url}`);
  }
}
