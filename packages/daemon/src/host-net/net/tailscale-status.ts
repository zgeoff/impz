import * as z from 'zod';
import { runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import { createTtlCache } from '../../platform/process/ttl-cache';

export interface TailscaleStatus {
  readonly state: string | null;

  // MagicDNS gives `imp-1` and so on while an older node still holds the
  // configured hostname.
  readonly hostname: string | null;

  readonly dnsName: string | null;

  readonly ip: string | null;
  readonly ips: readonly string[];
}

const IpListSchema = z.array(z.string()).nullable().optional();

const StatusSchema = z.object({
  BackendState: z.string(),
  Self: z
    .object({ HostName: z.string(), DNSName: z.string().optional(), TailscaleIPs: IpListSchema })
    .optional(),
});

const UNKNOWN: TailscaleStatus = { state: null, hostname: null, dnsName: null, ip: null, ips: [] };
const STATUS_TTL_MS = 30_000;

export function parseTailscaleStatus(json: string): TailscaleStatus {
  try {
    const status = StatusSchema.parse(JSON.parse(json));
    const ips = status.Self?.TailscaleIPs ?? [];
    const dnsName = status.Self?.DNSName?.replace(/\.$/u, '') ?? '';
    const dnsLabel = dnsName.split('.')[0] ?? '';

    return {
      state: status.BackendState,
      hostname: dnsLabel === '' ? (status.Self?.HostName ?? null) : dnsLabel,
      dnsName: dnsName === '' ? null : dnsName,
      ip: ips.find((ip) => ip.includes('.')) ?? ips[0] ?? null,
      ips,
    };
  } catch {
    return UNKNOWN;
  }
}

export async function readTailscaleStatus(
  configured: boolean,
  run: CommandRunner = runCommand,
): Promise<TailscaleStatus> {
  if (!configured) {
    return UNKNOWN;
  }

  try {
    const result = await run(['tailscale', 'status', '--json']);

    return parseTailscaleStatus(result.stdout);
  } catch {
    return UNKNOWN;
  }
}

export function createStatusCache(
  read: () => Promise<TailscaleStatus>,
  now: () => number,
): () => Promise<TailscaleStatus> {
  // lru-cache keeps an entry until its age passes the ttl, so one ms less reads
  // again at 30 s
  const cache = createTtlCache<'status', Promise<TailscaleStatus>>({
    max: 1,
    ttlMs: STATUS_TTL_MS - 1,
    now,
  });

  return () => {
    const cached = cache.get('status');

    if (cached !== undefined) {
      return cached;
    }

    const status = read();

    cache.set('status', status);

    return status;
  };
}
