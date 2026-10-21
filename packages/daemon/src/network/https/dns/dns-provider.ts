export interface DnsProvider {
  // adds one TXT value next to any the name already has; ACME asks for two
  // values on `_acme-challenge.<domain>` at once, one per certificate name
  readonly addTxt: (fqdn: string, value: string) => Promise<TxtRecord>;
  readonly removeTxt: (record: TxtRecord) => Promise<void>;

  readonly waitForTxt: (fqdn: string, values: readonly string[]) => Promise<void>;

  readonly setA: (fqdn: string, ip: string, owner?: string) => Promise<void>;

  readonly listA: (domain: string, owner: string) => Promise<ReadonlyMap<string, string>>;

  readonly removeA: (fqdn: string, owner: string) => Promise<void>;
}

// Cloudflare keeps 100 characters of a comment
const MAX_OWNER_LENGTH = 100;

export function buildPublicOwner(domain: string): string {
  const owner = `impd public imps of ${domain}`;

  if (owner.length <= MAX_OWNER_LENGTH) {
    return owner;
  }

  const hash = new Bun.CryptoHasher('sha256').update(domain).digest('hex');

  return `impd public imps of sha256:${hash.slice(0, 32)}`;
}

export interface TxtRecord {
  readonly fqdn: string;
  readonly value: string;

  readonly id: string;
}
