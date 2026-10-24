import { HEADSCALE_IMAGES } from '../../scripts/dev/headscale-images';
import type { CommandRunners } from './instance';
import { readMemberStatus } from './tailnet';
import { waitFor } from './wait-for';

export interface TailnetMemberOptions {
  readonly name: string;
  readonly key: string;
  readonly tailscaleArgs: string;
  readonly network?: string;
}

// The test-side member: a kernel tun, so docker exec reaches tailnet addresses,
// and MagicDNS in its resolv.conf, so it resolves node and service names.
export async function startTailnetMember(
  runners: CommandRunners,
  options: Readonly<TailnetMemberOptions>,
): Promise<void> {
  const created = await runners.runCommand(
    [
      'docker',
      'create',
      '--name',
      options.name,
      ...(options.network === undefined ? [] : ['--network', options.network]),
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
      `TS_HOSTNAME=${options.name}`,
      '-e',
      `TS_EXTRA_ARGS=${options.tailscaleArgs}`,
      HEADSCALE_IMAGES.tailscale,
    ],
    { env: { TS_AUTHKEY: options.key } },
  );

  if (created.exitCode !== 0) {
    throw new Error(`docker create ${options.name} exited ${String(created.exitCode)}`);
  }

  await runners.runChecked(['docker', 'start', options.name]);

  await waitFor(
    `${options.name} on the tailnet`,
    async () => {
      const status = await readMemberStatus(options.name, runners);

      if (status.BackendState !== 'Running') {
        throw new Error(`${options.name} is ${status.BackendState}`);
      }
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
}
