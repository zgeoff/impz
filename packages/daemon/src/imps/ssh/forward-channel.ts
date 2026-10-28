import { posix } from 'node:path';
import type { AcceptConnection, RejectConnection, ServerChannel } from 'ssh2';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { DialStream, DialTarget } from '../../vm/agent-client/dial-stream';
import { formatGuestFailure } from '../../vm/guest-channels/format-guest-failure';
import { IMP_RUN_DIR } from '../../vm/guest-channels/imp-run-dir';
import { runChannelRelay } from './channel-io';
import type { SshConnectionContext } from './ssh-connection-context';

const ADMINISTRATIVELY_PROHIBITED = 1;

// A forward to any host beyond the imp's own loopback would reach other guests, the host container
// or the network beyond.
const LOOPBACK_HOSTS: Readonly<Record<string, string>> = {
  localhost: '127.0.0.1',
  '127.0.0.1': '127.0.0.1',
  '::1': '[::1]',
};

export function resolveSocketTarget(socketPath: string): DialTarget | null {
  const path = posix.normalize(posix.join('/', socketPath));

  return path.startsWith(IMP_RUN_DIR) ? null : { network: 'unix', address: path };
}

export function resolveTcpTarget(host: string, port: number): DialTarget | null {
  const loopback = LOOPBACK_HOSTS[host.toLowerCase()];

  if (loopback === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return { network: 'tcp', address: `${loopback}:${String(port)}` };
}

export async function handleForward(
  accept: AcceptConnection<ServerChannel>,
  reject: RejectConnection,
  target: DialTarget | null,
  context: SshConnectionContext,
): Promise<void> {
  if (target === null) {
    reject(ADMINISTRATIVELY_PROHIBITED);

    return;
  }

  let dial: DialStream;

  try {
    await context.awake;

    dial = await context.backend.openDial(context.impName, target, 'ssh');
  } catch (error) {
    getImpdLogger('ssh')
      .with({ imp: context.impName })
      .warning('forward to {address}: {error}', {
        address: target.address,
        error: formatGuestFailure(error),
      });

    reject();

    return;
  }

  try {
    await runChannelRelay(accept(), dial);
  } catch (error) {
    getImpdLogger('ssh')
      .with({ imp: context.impName })
      .warning('forward to {address}: {error}', {
        address: target.address,
        error: formatGuestFailure(error),
      });
  }
}
