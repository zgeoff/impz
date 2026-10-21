import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { runImp } from './imp-cli';
import { instance } from './instance';

export interface BrokerUpstreams {
  readonly ca: string;
  readonly upstreams: Readonly<Record<string, string>>;
}

export function buildBrokerUpstreams(
  caPem: string,
  origin: string,
  hosts: readonly string[],
): BrokerUpstreams {
  return { ca: caPem, upstreams: Object.fromEntries(hosts.map((host) => [host, origin])) };
}

export function buildSlotGateway(slot: number): string {
  return `10.66.${String(Math.floor((slot * 4) / 256))}.${String(((slot * 4) % 256) + 1)}`;
}

const BrokerAuditSchema = z.array(
  z.object({
    host: z.string(),
    path: z.string(),
    status: z.number(),
    secret: z.string(),
    requestBytes: z.number(),
  }),
);

function readUpstreamsPath(): string {
  return join(instance.dataDir, 'broker-test-upstreams.json');
}

export async function writeBrokerUpstreams(upstreams: Readonly<BrokerUpstreams>): Promise<void> {
  await writeFile(readUpstreamsPath(), JSON.stringify(upstreams));
}

export async function removeBrokerUpstreams(): Promise<void> {
  await rm(readUpstreamsPath(), { force: true });
}

export async function readBrokerAudit(name: string) {
  const stdout = await runImp('audit', name, '--json');

  return BrokerAuditSchema.parse(JSON.parse(stdout));
}
