import * as z from 'zod';
import type { DnsProvider } from './dns-provider';
import { waitForTxt } from './wait-for-txt';
import type { WaitForTxtOptions } from './wait-for-txt';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const TXT_TTL_S = 60;
const A_TTL_S = 300;
const PAGE_SIZE = 500;
const ApiErrorSchema = z.object({ code: z.number().optional(), message: z.string() });

const EnvelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(ApiErrorSchema).default([]),
  result: z.unknown().optional(),

  result_info: z.object({ page: z.number(), total_pages: z.number() }).optional(),
});

type Envelope = z.infer<typeof EnvelopeSchema>;

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  name_servers: z.array(z.string()),
});

const RecordSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  content: z.string(),
  proxied: z.boolean().optional(),
  comment: z.string().nullable().optional(),
});

// on every A record impd writes: a record without it is someone else's, such
// as a website's at the zone apex, and impd never changes it
const MANAGED_COMMENT = 'managed by impd';

const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);

const ZoneListSchema = z.array(ZoneSchema);
const RecordListSchema = z.array(RecordSchema);

type Zone = z.infer<typeof ZoneSchema>;

/* @internal */
export type CloudflareZone = z.input<typeof ZoneSchema>;

/* @internal */
export type CloudflareRecord = z.input<typeof RecordSchema>;

interface CloudflareOptions {
  readonly readToken: () => Promise<string>;
  readonly apiUrl?: string;
  readonly propagation?: WaitForTxtOptions;
  readonly log?: (message: string) => void;
}

export function createCloudflareProvider(options: CloudflareOptions): DnsProvider {
  const base = options.apiUrl ?? CLOUDFLARE_API;

  const zones = new Map<string, Zone>();

  let zonesToken: string | null = null;

  const sendEnvelope = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ envelope: Envelope; token: string }> => {
    const token = await options.readToken();

    if (token !== zonesToken) {
      zones.clear();

      zonesToken = token;
    }

    const json = body === undefined ? null : JSON.stringify(body);

    const response = await sendFetch(`${base}${path}`, token, method, json);
    const text = await response.text();

    const parsed = EnvelopeSchema.safeParse(parseJsonOrNull(text));

    if (!response.ok || !parsed.success || !parsed.data.success) {
      const reasons = parsed.success
        ? parsed.data.errors.map((error) => error.message).join('; ')
        : 'no Cloudflare answer';

      throw new Error(
        `Cloudflare ${method} ${path.split('?')[0] ?? path}: ${String(response.status)} ${reasons}`,
      );
    }

    return { envelope: parsed.data, token };
  };

  const sendRequest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const sent = await sendEnvelope(method, path, body);

    return sent.envelope.result;
  };

  const readZone = async (fqdn: string): Promise<Zone> => {
    const cached = zones.get(fqdn);

    if (cached !== undefined) {
      return cached;
    }

    const labels = fqdn.split('.');
    const first = labels[0] === '*' ? 1 : 0;

    for (let index = first; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');

      const sent = await sendEnvelope('GET', `/zones?name=${encodeURIComponent(candidate)}`);

      const found = ZoneListSchema.parse(sent.envelope.result);
      const zone = found.find((item) => item.name === candidate);

      if (zone !== undefined) {
        if (sent.token === zonesToken) {
          zones.set(fqdn, zone);
        }

        return zone;
      }
    }

    throw new Error(`Cloudflare: no zone this token can see holds ${fqdn}`);
  };

  const readOwnA = async (zoneId: string, fqdn: string, owner: string) => {
    const query = `type=A&name=${encodeURIComponent(fqdn)}`;

    const result = await sendRequest('GET', `/zones/${zoneId}/dns_records?${query}`);

    return RecordListSchema.parse(result).filter((item) => item.comment === owner);
  };

  return {
    addTxt: async (fqdn, value) => {
      const zone = await readZone(fqdn);

      const result = await sendRequest('POST', `/zones/${zone.id}/dns_records`, {
        type: 'TXT',
        name: fqdn,
        content: value,
        ttl: TXT_TTL_S,
      });

      const created = RecordSchema.parse(result);

      return { fqdn, value, id: `${zone.id}/${created.id}` };
    },
    removeTxt: async (record) => {
      await sendRequest('DELETE', `/zones/${record.id.replace('/', '/dns_records/')}`);
    },
    waitForTxt: async (fqdn, values) => {
      const zone = await readZone(fqdn);

      await waitForTxt(zone.name_servers, fqdn, values, options.propagation);
    },
    setA: async (fqdn, ip, owner = MANAGED_COMMENT) => {
      const zone = await readZone(fqdn);

      const query = `name=${encodeURIComponent(fqdn)}`;

      const result = await sendRequest('GET', `/zones/${zone.id}/dns_records?${query}`);

      const existing = RecordListSchema.parse(result).filter((item) =>
        ADDRESS_TYPES.has(item.type ?? ''),
      );

      const foreign = existing.find((item) => item.comment !== owner);

      if (foreign !== undefined) {
        throw new Error(
          `Cloudflare: ${fqdn} already has a record impd did not make (${foreign.type ?? ''} ${foreign.content}); remove it, or give impd a name of its own in IMP_DOMAIN`,
        );
      }

      if (existing.length > 1) {
        options.log?.(
          `impd: https: warning: ${fqdn} has ${String(existing.length)} A records impd made; it updates only the first`,
        );
      }

      const record = {
        type: 'A',
        name: fqdn,
        content: ip,
        ttl: A_TTL_S,

        // a proxied record sends clients to Cloudflare's edge, which cannot reach a tailnet address
        proxied: false,
        comment: owner,
      };

      const [current] = existing;

      if (current === undefined) {
        await sendRequest('POST', `/zones/${zone.id}/dns_records`, record);
      } else if (current.content !== ip || current.proxied === true) {
        await sendRequest('PUT', `/zones/${zone.id}/dns_records/${current.id}`, record);
      }
    },
    listA: async (domain, owner) => {
      const zone = await readZone(domain);

      const found = new Map<string, string>();

      // `name.endswith` and `per_page` up to 5,000,000 are in Cloudflare's
      // list-records docs. Every page: by result_info when it comes, else
      // until a page is short, in case a page holds fewer than asked for.
      for (let page = 1; ; page += 1) {
        const query = `type=A&name.endswith=${encodeURIComponent(`.${domain}`)}&per_page=${String(PAGE_SIZE)}&page=${String(page)}`;

        const sent = await sendEnvelope('GET', `/zones/${zone.id}/dns_records?${query}`);

        const envelope = sent.envelope;
        const records = RecordListSchema.parse(envelope.result);

        for (const record of records) {
          const name = record.name ?? '';

          if (record.comment === owner && name.endsWith(`.${domain}`)) {
            found.set(name, record.content);
          }
        }

        const pages = envelope.result_info?.total_pages;
        const isLast = pages === undefined ? records.length < PAGE_SIZE : page >= pages;

        if (records.length === 0 || isLast) {
          return found;
        }
      }
    },
    removeA: async (fqdn, owner) => {
      const zone = await readZone(fqdn);
      const records = await readOwnA(zone.id, fqdn, owner);

      for (const record of records) {
        await sendRequest('DELETE', `/zones/${zone.id}/dns_records/${record.id}`);
      }
    },
  };
}

// fetch, with the token cut out of its errors: Bun before 1.4.3 names a header
// value it refuses, and the error reaches the log and system info
async function sendFetch(
  url: string,
  token: string,
  method: string,
  body: string | null,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== null && { 'content-type': 'application/json' }),
      },
      ...(body !== null && { body }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // oxlint-disable-next-line preserve-caught-error -- the cause holds the token
    throw new Error(message.replaceAll(token, '<token>'));
  }
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
