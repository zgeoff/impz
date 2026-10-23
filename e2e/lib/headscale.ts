import { join } from 'node:path';
import * as z from 'zod';
import { HEADSCALE_IMAGES } from '../../scripts/dev/headscale-images';
import { FIXTURES_DIR, instance, runChecked, runCommand } from './instance';
import { readMemberStatus } from './tailnet';
import { waitFor } from './wait-for';

export const HEADSCALE_LOGIN_SERVER = 'http://headscale:8080';
export const HEADSCALE_TAGS = 'tag:imp-e2e';

export interface HeadscaleTailnet {
  readonly key: string;
  readonly network: string;
  readonly member: string;
}

export function buildHeadscaleNames(container: string = instance.container) {
  return {
    network: `${container}-ts`,
    headscale: `${container}-headscale`,
    member: `${container}-ts-member`,
  } as const;
}

const KeySchema = z.object({ key: z.string().min(1) });
const UserSchema = z.object({ id: z.number() });

// Never print a key. Each run's control server is new, so a node that a
// previous run left keeps no address here.
export async function startHeadscale(
  container: string = instance.container,
): Promise<HeadscaleTailnet> {
  const names = buildHeadscaleNames(container);

  await stopHeadscale(container);
  await runChecked(['docker', 'network', 'create', names.network]);

  await runChecked([
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

  await runChecked(['docker', 'start', names.headscale]);

  await waitFor(
    'Headscale to answer',
    () => runChecked(['docker', 'exec', names.headscale, 'headscale', 'health']),
    { timeoutMs: 30_000, intervalMs: 200 },
  );

  // Reusable: one key joins A at every start and reboot, and B.
  const tagged = await runChecked([
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

  const user = await runChecked([
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

  const memberKey = await runChecked([
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

  await startMember(names, KeySchema.parse(JSON.parse(memberKey)).key);

  return {
    key: KeySchema.parse(JSON.parse(tagged)).key,
    network: names.network,
    member: names.member,
  };
}

export async function stopHeadscale(container: string = instance.container): Promise<void> {
  const names = buildHeadscaleNames(container);

  await runCommand(['docker', 'rm', '-f', names.member, names.headscale]);
  await runCommand(['docker', 'network', 'rm', names.network]);
}

// A network of a suite's own, such as the moves suites' network: the relay
// serves plain HTTP, which tailscaled refuses, so peers meet only on a network
// they share, and each node reaches Headscale by its alias there.
export async function connectHeadscale(
  network: string,
  container: string = instance.container,
): Promise<void> {
  await runChecked([
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
  network: string,
  container: string = instance.container,
): Promise<void> {
  await runCommand([
    'docker',
    'network',
    'disconnect',
    '--force',
    network,
    buildHeadscaleNames(container).headscale,
  ]);
}

// The test-side member: a kernel tun, so docker exec reaches tailnet addresses,
// and MagicDNS in its resolv.conf, so it resolves node names.
async function startMember(
  names: ReturnType<typeof buildHeadscaleNames>,
  key: string,
): Promise<void> {
  const created = await runCommand(
    [
      'docker',
      'create',
      '--name',
      names.member,
      '--network',
      names.network,
      '--cap-add',
      'NET_ADMIN',
      '--device',
      '/dev/net/tun',
      '-e',
      'TS_AUTHKEY',
      '-e',
      'TS_USERSPACE=false',
      '-e',
      'TS_ACCEPT_DNS=true',
      '-e',
      'TS_HOSTNAME=e2e-member',
      '-e',
      `TS_EXTRA_ARGS=--login-server=${HEADSCALE_LOGIN_SERVER}`,
      HEADSCALE_IMAGES.tailscale,
    ],
    { env: { TS_AUTHKEY: key } },
  );

  if (created.exitCode !== 0) {
    throw new Error(`docker create ${names.member} exited ${String(created.exitCode)}`);
  }

  await runChecked(['docker', 'start', names.member]);

  await waitFor(
    `${names.member} on the tailnet`,
    async () => {
      const status = await readMemberStatus(names.member);

      if (status.BackendState !== 'Running') {
        throw new Error(`${names.member} is ${status.BackendState}`);
      }
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
}
