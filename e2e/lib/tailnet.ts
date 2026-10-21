import * as z from 'zod';
import { runImpWith } from './imp-cli';
import type { ImpRunOptions } from './imp-cli';
import { runCommand } from './instance';
import { waitFor } from './wait-for';

const PeerSchema = z.object({
  DNSName: z.string().default(''),
  TailscaleIPs: z.array(z.string()).default([]),
  Online: z.boolean().default(false),
  Tags: z.array(z.string()).default([]),
});

const TailscaleStatusSchema = z.object({
  BackendState: z.string(),
  Peer: z.record(z.string(), PeerSchema).default({}),
});

export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>;

const SelfSchema = z.object({ Tags: z.array(z.string()).default([]) });
const SelfTagsSchema = z.object({ Self: SelfSchema });

export function parseSelfTags(stdout: string): string[] {
  const json: unknown = JSON.parse(stdout);

  return SelfTagsSchema.parse(json).Self.Tags;
}

export interface TailnetPeer {
  readonly DNSName: string;
  readonly TailscaleIPs: readonly string[];
  readonly Online: boolean;
  readonly Tags?: readonly string[];
}

export interface TailnetNode {
  readonly fqdn: string;

  readonly short: string;

  readonly tags: readonly string[];
}

const TAILNET_NOT_READY =
  'tailscale needs the tag:imp-e2e OAuth client (op://$IMP_OP_VAULT/imp-e2e-tailscale-oauth) and this machine on the tailnet';

export function isTailnetReady(
  status: Readonly<Pick<TailscaleStatus, 'BackendState'>> | null,
  hasKey: boolean,
): boolean {
  return hasKey && status?.BackendState === 'Running';
}

export function requireTailnetReady(
  status: Readonly<Pick<TailscaleStatus, 'BackendState'>> | null,
  hasKey: boolean,
): void {
  if (!isTailnetReady(status, hasKey)) {
    throw new Error(TAILNET_NOT_READY);
  }
}

export function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let json: unknown;

  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }

  const status = TailscaleStatusSchema.safeParse(json);

  return status.success ? status.data : null;
}

// By IP and not by name: an offline node from an earlier run can still hold
// the name, and then this node is imp-1.
export function findTailnetNode(peers: readonly TailnetPeer[], ip: string): TailnetNode | null {
  const peer = peers.find((candidate) => candidate.Online && candidate.TailscaleIPs.includes(ip));

  if (peer === undefined || peer.DNSName === '') {
    return null;
  }

  const fqdn = peer.DNSName.replace(/\.$/v, '');
  const [short = ''] = fqdn.split('.');

  return { fqdn, short, tags: peer.Tags ?? [] };
}

export async function readLocalTailscaleStatus(): Promise<TailscaleStatus | null> {
  const result = await runCommand(['tailscale', 'status', '--json']).catch(() => null);

  return result === null ? null : parseTailscaleStatus(result.stdout);
}

const InfoTailscaleSchema = z.object({
  tailscale: z.object({ state: z.string().nullable(), ip: z.string().nullable() }),
});

export async function waitForTailnetIp(options: Readonly<ImpRunOptions> = {}): Promise<string> {
  const ip = await waitFor(
    'impd tailscale state Running',
    async () => {
      const stdout = await runImpWith(options, 'info', '--json');

      const info = InfoTailscaleSchema.parse(JSON.parse(stdout));

      if (info.tailscale.state !== 'Running' || info.tailscale.ip === null) {
        throw new Error(`impd tailscale state ${String(info.tailscale.state)}`);
      }

      return info.tailscale.ip;
    },
    { timeoutMs: 120_000 },
  );

  return ip;
}

export function findServiceUrl(stdout: string): string | null {
  return (
    stdout.split('\n').find((line) => /^https:\/\/[\w\-]+\.[\w\-]+\.ts\.net$/v.test(line)) ?? null
  );
}

export function sendTailnetRpc(ip: string, path: string, input: unknown): Promise<Response> {
  return fetch(`http://${ip}:7070/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(30_000),
  });
}

export async function readTailnetBody(url: string, host?: string): Promise<string> {
  const response = await fetch(url, {
    ...(host !== undefined && { headers: { host } }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}: ${body}`);
  }

  return body.trim();
}
