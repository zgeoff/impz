import * as z from 'zod';
import { runImpWith } from './imp-cli';
import type { ImpRunOptions } from './imp-cli';
import { runChecked, runCommand } from './instance';
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

// The harness's test-side member of the Headscale tailnet: a container, since
// this machine's own tailscaled stays on the tailnet it already has.
export function readTailnetMember(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const member = env['E2E_TAILNET_MEMBER'] ?? '';

  if (member === '') {
    throw new Error('no E2E_TAILNET_MEMBER: the e2e harness starts the tailnet for this suite');
  }

  return member;
}

export async function readMemberStatus(member: string): Promise<TailscaleStatus> {
  const stdout = await runChecked(['docker', 'exec', member, 'tailscale', 'status', '--json']);

  const status = parseTailscaleStatus(stdout);

  if (status === null) {
    throw new Error(`${member} gave no tailscale status: ${stdout}`);
  }

  return status;
}

export async function readMemberBody(member: string, url: string, host?: string): Promise<string> {
  const result = await runCommand([
    'docker',
    'exec',
    member,
    'wget',
    '-q',
    '-O',
    '-',
    '-T',
    '30',
    ...(host === undefined ? [] : ['--header', `Host: ${host}`]),
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`${url} from ${member}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

export interface MemberResponse {
  readonly status: number;
  readonly body: string;
}

export async function sendMemberRpc(
  member: string,
  ip: string,
  path: string,
  input: unknown,
): Promise<MemberResponse> {
  const result = await runCommand([
    'docker',
    'exec',
    member,
    'wget',
    '-q',
    '-S',
    '-O',
    '-',
    '-T',
    '30',
    '--header',
    'content-type: application/json',
    '--post-data',
    JSON.stringify({ json: input }),
    `http://${ip}:7070/rpc/${path}`,
  ]);

  const status = parseWgetStatus(result.stderr);

  if (status === null) {
    throw new Error(`${path} at ${ip} from ${member} gave no HTTP status: ${result.stderr.trim()}`);
  }

  return { status, body: result.stdout };
}

// BusyBox wget prints each response's status line with -S, and on an error
// status exits 1 without the body.
export function parseWgetStatus(stderr: string): number | null {
  const statuses = [...stderr.matchAll(/^\s*HTTP\/[\d.]+ (?<status>\d{3})\b/gmv)];
  const status = statuses.at(-1)?.groups?.['status'];

  return status === undefined ? null : Number(status);
}
