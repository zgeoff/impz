import { faker } from '@faker-js/faker';
import type { TailscaleStatus } from '../../src/host-net/net/tailscale-status';
import type { CommandResult } from '../../src/platform/process/run-command';

interface StubTailnetNode {
  readonly node: string;
  readonly login: string | null;
  readonly tags?: readonly string[];

  // An older tailscale leaves the stable ID out of its whois answer.
  readonly stableId?: string | null;
}

interface StubTailscaleOptions {
  readonly status?: Partial<TailscaleStatus>;
}

const TAILNET = 'tail1234.ts.net';

export function buildStubTailscale(options: Readonly<StubTailscaleOptions> = {}) {
  const hostname = faker.word.noun().toLowerCase();
  const ip = `100.${String(faker.number.int({ min: 64, max: 127 }))}.${String(faker.number.int(255))}.${String(faker.number.int({ min: 1, max: 254 }))}`;

  const status: TailscaleStatus = {
    state: 'Running',
    hostname,
    dnsName: `${hostname}.${TAILNET}`,
    ip,
    ips: [ip],
    ...options.status,
  };

  const peers = new Map<string, string>();

  const asked: string[] = [];

  const registerPeer = (address: string, peer: Readonly<StubTailnetNode>): void => {
    const tags = peer.tags ?? [];

    // tailscale's whois answers a tagged node with a placeholder user.
    const login = tags.length > 0 || peer.login === null ? 'tagged-devices' : peer.login;

    peers.set(
      address,
      JSON.stringify({
        Node: {
          ID: faker.number.int({ min: 1, max: 1_000_000 }),
          ...(peer.stableId !== undefined && peer.stableId !== null && { StableID: peer.stableId }),
          Name: `${peer.node}.${TAILNET}.`,
          ...(tags.length > 0 && { Tags: tags }),
          Addresses: [`${address}/32`],
        },
        UserProfile: {
          ID: faker.number.int({ min: 1, max: 1_000_000 }),
          LoginName: login,
          DisplayName: login,
        },
        CapMap: {},
      }),
    );
  };

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    const [program, verb, flag, address] = argv;

    if (program === 'tailscale' && verb === 'whois' && flag === '--json' && address !== undefined) {
      asked.push(address);

      const answer = peers.get(address);

      const result: CommandResult =
        answer === undefined
          ? { exitCode: 1, stdout: '', stderr: 'peer not found\n' }
          : { exitCode: 0, stdout: answer, stderr: '' };

      return Promise.resolve(result);
    }

    if (program === 'tailscale' && verb === 'status' && flag === '--json') {
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          BackendState: status.state,
          Self: {
            HostName: status.hostname,
            DNSName: status.dnsName === null ? '' : `${status.dnsName}.`,
            TailscaleIPs: status.ips,
          },
        }),
        stderr: '',
      });
    }

    return Promise.reject(new Error(`the stub tailscale does not run ${argv.join(' ')}`));
  };

  const outage: { error: Error | null } = { error: null };

  const readTailscale = (): Promise<TailscaleStatus> => {
    const error = outage.error;

    if (error === null) {
      return Promise.resolve(status);
    }

    outage.error = null;

    return Promise.reject(error);
  };

  return {
    status,
    asked,
    registerPeer,
    run,
    readTailscale,
    failNextStatus: (error: Error) => {
      outage.error = error;
    },
  };
}
