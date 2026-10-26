import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { runImpWith } from './imp-cli';
import type { DevInstance } from './instance';
import { readToken, runInContainer } from './instance';
import { HOST_B } from './move-hosts';
import type { MoveHosts } from './move-hosts';
import type { StubUpstream } from './start-stub-upstream';

export const HOST_A = 'a';

export interface RpcAnswer {
  readonly ok: boolean;
  readonly body: unknown;
}

const LeaseSchema = z.object({
  owner: z.object({ principal: z.string(), label: z.string() }),
  until: z.iso.datetime().nullable(),
});

export type MoveLease = z.infer<typeof LeaseSchema>;

const HostImpSchema = z.object({ host: z.string(), name: z.string(), move: z.string().optional() });
const HostImpsSchema = z.object({ imps: z.array(HostImpSchema) });

export interface HostListing {
  readonly rows: readonly string[];
  readonly imps: readonly z.infer<typeof HostImpSchema>[];
}

export function parseRpcAnswer(ok: boolean, raw: unknown): RpcAnswer {
  return { ok, body: z.object({ json: z.unknown() }).parse(raw).json };
}

export function parseHostListing(table: string, json: string, name: string): HostListing {
  const rows = table
    .trimEnd()
    .split('\n')
    .filter((row) => row.split(/\s+/v)[1] === name);

  const body = HostImpsSchema.parse(JSON.parse(json));

  return { rows, imps: body.imps.filter((imp) => imp.name === name) };
}

export function parseNftSetAddresses(listed: string): readonly string[] {
  const elements = /elements = \{(?<list>[^\}]*)\}/v.exec(listed)?.groups?.['list'] ?? '';

  return [...elements.matchAll(/\d+\.\d+\.\d+\.\d+/gv)].map((match) => match[0]);
}

export async function sendHostRpc(
  target: DevInstance,
  path: string,
  input: unknown,
): Promise<RpcAnswer> {
  const token = await readToken(target);

  const response = await fetch(`${target.apiUrl}/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(60_000),
  });

  const raw: unknown = await response.json();

  return parseRpcAnswer(response.ok, raw);
}

export async function listLeasesOn(target: DevInstance, name: string): Promise<MoveLease[]> {
  const answer = await sendHostRpc(target, 'leases/list', { name });

  return z.array(LeaseSchema).parse(answer.body);
}

export async function startMoveSend(target: DevInstance, name: string): Promise<void> {
  const answer = await sendHostRpc(target, 'moves/prepare', { name, targetStorage: 'xfs' });

  if (!answer.ok) {
    throw new Error(`moves/prepare for ${name} failed: ${JSON.stringify(answer.body)}`);
  }
}

export async function writeBothHostsConfig(
  hosts: Readonly<MoveHosts>,
  directory: string,
): Promise<Record<string, string>> {
  const env = { XDG_CONFIG_HOME: directory };

  const tokenA = await readToken(hosts.hostA);

  await runImpWith({ stdin: `${tokenA}\n`, env }, 'login', hosts.hostA.apiUrl, '--name', HOST_A);

  const tokenB = await readToken(hosts.hostB);

  await runImpWith({ stdin: `${tokenB}\n`, env }, 'login', hosts.hostB.apiUrl, '--name', HOST_B);

  return env;
}

export async function listAllHosts(
  env: Readonly<Record<string, string>>,
  name: string,
): Promise<HostListing> {
  const table = await runImpWith({ env }, 'ls', '--all');
  const json = await runImpWith({ env }, 'ls', '--all', '--json');

  return parseHostListing(table, json, name);
}

export function buildUpstreamsPath(target: DevInstance): string {
  return join(target.dataDir, 'broker-test-upstreams.json');
}

export async function writeUpstreamsFile(
  target: DevInstance,
  upstream: Readonly<StubUpstream>,
): Promise<void> {
  await writeFile(
    buildUpstreamsPath(target),
    JSON.stringify({
      ca: upstream.caPem,
      upstreams: { 'github.com': upstream.origin, 'api.github.com': upstream.origin },
    }),
  );
}

export async function readAllowSet(target: DevInstance, slot: number): Promise<readonly string[]> {
  const listed = await runInContainer(
    ['nft', 'list', 'set', 'inet', 'imp_egress', `allow${String(slot)}`],
    target,
  );

  return parseNftSetAddresses(listed.stdout);
}

export async function readJailOwners(
  target: DevInstance,
  id: string,
  slot: number,
): Promise<readonly string[]> {
  const directory = `/var/lib/imp/imps/${id}`;

  const result = await runInContainer(
    [
      'sh',
      '-c',
      `pid=$(pgrep -f 'firecracker.*imps/${id}/' | head -n 1)
      disk=$(ls ${directory}/disk.ext4 ${directory}/disk/rootfs.ext4 2>/dev/null | head -n 1)
      stat -c %u "/proc/$pid" "$disk"
      cat /sys/class/net/imp${String(slot)}/owner`,
    ],
    target,
  );

  return result.stdout.trim().split('\n');
}
