import { join } from 'node:path';
import * as z from 'zod';
import { HEADSCALE_IMAGES } from '../../../scripts/dev/headscale-images';
import { FIXTURES_DIR, instance } from './instance';
import type { CommandRunners } from './instance';
import { startTailnetMember } from './tailnet-member';
import { waitFor } from './wait-for';

export const HEADSCALE_LOGIN_SERVER = 'http://headscale:8080';
export const HEADSCALE_TAGS = 'tag:imp-e2e';

export interface HeadscaleTailnet {
  readonly key: string;
  readonly network: string;
  readonly member: string;
}

function buildHeadscaleNames(container: string = instance.container) {
  return {
    network: `${container}-ts`,
    headscale: `${container}-headscale`,
    member: `${container}-ts-member`,
  } as const;
}

const KeySchema = z.object({ key: z.string().min(1) });
const UserSchema = z.object({ id: z.number() });

export async function startHeadscale(
  runners: CommandRunners,
  container: string = instance.container,
): Promise<HeadscaleTailnet> {
  const names = buildHeadscaleNames(container);

  await stopHeadscale(runners, container);

  // The dev instance outlives the run on this network, which then stays.
  const network = await runners.runCommand(['docker', 'network', 'inspect', names.network]);

  if (network.exitCode !== 0) {
    await runners.runChecked(['docker', 'network', 'create', names.network]);
  }

  await runners.runChecked([
    'docker',
    'create',
    '--name',
    names.headscale,
    '--network',
    names.network,
    '--network-alias',
    'headscale',
    '-v',
    `${join(FIXTURES_DIR, 'headscale')}:/etc/headscale:ro`,
    '--tmpfs',
    '/var/lib/headscale',
    HEADSCALE_IMAGES.headscale,
    'serve',
  ]);

  await runners.runChecked(['docker', 'start', names.headscale]);

  await waitFor(
    'Headscale to answer',
    () => runners.runChecked(['docker', 'exec', names.headscale, 'headscale', 'health']),
    { timeoutMs: 30_000, intervalMs: 200 },
  );

  // Reusable: one key joins A at every start and reboot, and B.
  const tagged = await runners.runChecked([
    'docker',
    'exec',
    names.headscale,
    'headscale',
    'preauthkeys',
    'create',
    '--tags',
    HEADSCALE_TAGS,
    '--ephemeral',
    '--reusable',
    '--expiration',
    '24h',
    '-o',
    'json',
  ]);

  const user = await runners.runChecked([
    'docker',
    'exec',
    names.headscale,
    'headscale',
    'users',
    'create',
    'e2e-member',
    '-o',
    'json',
  ]);

  const userID = UserSchema.parse(JSON.parse(user)).id;

  const memberKey = await runners.runChecked([
    'docker',
    'exec',
    names.headscale,
    'headscale',
    'preauthkeys',
    'create',
    '--user',
    String(userID),
    '--ephemeral',
    '-o',
    'json',
  ]);

  await startTailnetMember(runners, {
    name: names.member,
    key: KeySchema.parse(JSON.parse(memberKey)).key,
    tailscaleArgs: `--login-server=${HEADSCALE_LOGIN_SERVER}`,
    network: names.network,
  });

  return {
    key: KeySchema.parse(JSON.parse(tagged)).key,
    network: names.network,
    member: names.member,
  };
}

export async function stopHeadscale(
  runners: CommandRunners,
  container: string = instance.container,
): Promise<void> {
  const names = buildHeadscaleNames(container);

  await runners.runCommand(['docker', 'rm', '-f', names.member, names.headscale]);
  await runners.runCommand(['docker', 'network', 'rm', names.network]);
}

// The relay serves plain HTTP, which tailscaled refuses, so peers meet only on a
// network they share, and each node reaches Headscale by its alias there.
export async function connectHeadscale(
  runners: CommandRunners,
  network: string,
  container: string = instance.container,
): Promise<void> {
  await runners.runChecked([
    'docker',
    'network',
    'connect',
    '--alias',
    'headscale',
    network,
    buildHeadscaleNames(container).headscale,
  ]);
}

export async function disconnectHeadscale(
  runners: CommandRunners,
  network: string,
  container: string = instance.container,
): Promise<void> {
  await runners.runCommand([
    'docker',
    'network',
    'disconnect',
    '--force',
    network,
    buildHeadscaleNames(container).headscale,
  ]);
}
