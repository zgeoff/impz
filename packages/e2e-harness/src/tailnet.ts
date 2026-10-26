import * as z from 'zod';
import { runImpWith } from './imp-cli';
import type { ImpRunOptions } from './imp-cli';
import { runCommand } from './instance';
import type { CommandRunners } from './instance';
import { waitFor } from './wait-for';

const PeerSchema = z.object({
  DNSName: z.string().default(''),
  TailscaleIPs: z.array(z.string()).default([]),
  Online: z.boolean().default(false),
  Tags: z.array(z.string()).default([]),
});

const TailscaleStatusSchema = z.object({
  BackendState: z.string(),

  // A node alone on its tailnet gives null.
  Peer: z
    .record(z.string(), PeerSchema)
    .nullish()
    .transform((peers) => peers ?? {}),
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

export function isTailnetReady(
  status: Readonly<Pick<TailscaleStatus, 'BackendState'>> | null,
  hasKey: boolean,
): boolean {
  return hasKey && status?.BackendState === 'Running';
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

// The harness's test-side member of the run's tailnet: a container, since this
// machine's own tailscaled stays on the tailnet it already has.
export function readTailnetMember(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const member = env['E2E_TAILNET_MEMBER'] ?? '';

  if (member === '') {
    throw new Error('no E2E_TAILNET_MEMBER: the e2e harness starts the tailnet for this suite');
  }

  return member;
}

export async function readHarnessMemberStatus(
  runners: Pick<CommandRunners, 'runChecked'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TailscaleStatus | null> {
  const member = env['E2E_TAILNET_MEMBER'] ?? '';

  if (member === '') {
    return null;
  }

  const status = await readMemberStatus(member, runners);

  if (status.BackendState !== 'Running') {
    throw new Error(`${member} is ${status.BackendState}, not Running`);
  }

  return status;
}

export async function readMemberStatus(
  member: string,
  runners: Pick<CommandRunners, 'runChecked'>,
): Promise<TailscaleStatus> {
  const stdout = await runners.runChecked([
    'docker',
    'exec',
    member,
    'tailscale',
    'status',
    '--json',
  ]);

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
