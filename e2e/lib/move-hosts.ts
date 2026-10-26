import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { match } from 'ts-pattern';
import { readTextOrNull } from '../../scripts/lib/read-text-or-null.ts';
import type { HarnessEnv } from './config';
import { connectHeadscale, disconnectHeadscale } from './headscale';
import { createInstanceClient, runImpWith } from './imp-cli';
import type { DevInstance } from './instance';
import {
  REPO_ROOT,
  createInstance,
  instance,
  readToken,
  runChecked,
  runCommand,
  runDevScript,
} from './instance';
import { checkPrivileges } from './privileges';
import { removeDataDir } from './remove-data-dir';
import { resetBaseline } from './reset-baseline';
import { resolveDataWipe } from './resolve-data-wipe';

// B's data dir stays between runs, so only its first start seeds the default
// image.

const RAM_BUDGET_MIB = '2048';
const DEFAULT_MEMORY_MIB = '512';

export const HOST_B = 'b';

export interface MoveHosts {
  readonly hostA: DevInstance;
  readonly hostB: DevInstance;
  readonly network: string;

  readonly gateway: string;

  readonly cliEnv: Readonly<Record<string, string>>;
}

export interface MoveNetwork {
  readonly subnet: string;
  readonly gateway: string;
  readonly ipA: string;
  readonly ipB: string;
}

// Inside 10/8 but clear of IMP_SUBNET's 10.66/16 and of Docker's 172.x pools,
// so runs in other worktrees and e2e slots never share it.
export function buildMoveNetwork(offset: number): MoveNetwork {
  const second = 100 + Math.floor(offset / 256);

  if (!Number.isInteger(offset) || offset < 0 || second > 255) {
    throw new Error(`no move network for port offset ${String(offset)}`);
  }

  const base = `10.${String(second)}.${String(offset % 256)}`;

  return {
    subnet: `${base}.0/24`,
    gateway: `${base}.1`,
    ipA: `${base}.10`,
    ipB: `${base}.11`,
  };
}

export interface MoveHostsOptions {
  readonly tailnet: 'off' | 'headscale' | 'tailscale';

  readonly env?: Readonly<Record<string, string>>;
}

function readOffset(): number {
  return Number(process.env['IMP_DEV_PORT_OFFSET'] ?? '0');
}

function buildNames() {
  return {
    network: `${instance.container}-mv`,
    container: `${instance.container}-mv-b`,
    cliDir: join(REPO_ROOT, '.cache', 'e2e', `${instance.container}-mv-cli`),
  };
}

function buildHostEnv(
  options: MoveHostsOptions,
  network: MoveNetwork,
  ip: string,
): Record<string, string> {
  const shared = {
    ...options.env,
    IMP_RAM_BUDGET_MIB: RAM_BUDGET_MIB,
    IMP_DEFAULT_MEMORY_MIB: DEFAULT_MEMORY_MIB,
  };

  if (options.tailnet !== 'off') {
    return shared;
  }

  return {
    ...shared,
    IMP_E2E: '1',
    IMP_MOVE_TEST_CIDR: network.subnet,
    IMP_PEER_URL: `http://${ip}:7070`,
  };
}

// B would inherit A's IMP_ZFS_ROOT otherwise, and two impds on one dataset
// take each other's disks.
export function pickHostBZfsRoot(env: HarnessEnv): string | undefined {
  const root = env['IMP_ZFS_ROOT'] ?? '';

  return env['IMP_STORAGE_BACKEND'] === 'zfs' && root !== '' ? `${root}-mv-b` : undefined;
}

function readHostB(options: MoveHostsOptions): DevInstance {
  const names = buildNames();
  const network = buildMoveNetwork(readOffset());
  const zfsRoot = pickHostBZfsRoot(process.env);

  return createInstance({
    container: names.container,
    dataDir: `${instance.dataDir}-mv-b`,
    network: names.network,
    ip: network.ipB,
    env: {
      ...buildHostEnv(options, network, network.ipB),

      ...(options.tailnet === 'off'
        ? { IMP_DEV_TAILNET: '0' }
        : { IMP_TAILSCALE_HOSTNAME: names.container }),
      ...(zfsRoot !== undefined && { IMP_ZFS_ROOT: zfsRoot }),
    },
  });
}

async function checkAOnNetwork(network: string): Promise<boolean> {
  const result = await runCommand([
    'docker',
    'inspect',
    '-f',
    `{{if index .NetworkSettings.Networks "${network}"}}yes{{end}}`,
    instance.container,
  ]);

  return result.stdout.trim() === 'yes';
}

// --bail skips afterAll, so a failed run can leave B up and A on the network.
export async function removeMoveLeftovers(env: HarnessEnv): Promise<void> {
  const names = buildNames();

  await runDevScript('down', readHostB({ tailnet: 'off' }), {}, env);

  const isOnNetwork = await checkAOnNetwork(names.network);

  if (isOnNetwork) {
    await runDevScript('reboot', instance, {}, env);
  }

  await disconnectHeadscale({ runCommand, runChecked }, names.network);
  await runCommand(['docker', 'network', 'rm', names.network]);
}

export type HostBFixtureName = 'host-b' | 'host-b-tailnet' | 'host-b-tailnet-names';

export function readMoveOptions(fixture: HostBFixtureName): MoveHostsOptions {
  return match(fixture)
    .with('host-b', (): MoveHostsOptions => ({ tailnet: 'off' }))
    .with('host-b-tailnet', (): MoveHostsOptions => ({ tailnet: 'headscale' }))
    .with('host-b-tailnet-names', (): MoveHostsOptions => ({
      tailnet: 'tailscale',
      env: { IMP_TAILNET_NAMES: '1', IMP_TAILNET_NAME_PREFIX: 'e2e-' },
    }))
    .exhaustive();
}

// A tailnet move too puts A beside B on the move network: the two meet there
// directly, and through Headscale's alias on it.
export function buildMoveSettings(
  options: Readonly<MoveHostsOptions>,
  offset: number,
): Record<string, string> {
  const names = buildNames();
  const network = buildMoveNetwork(offset);

  return {
    ...buildHostEnv(options, network, network.ipA),
    IMP_DEV_NETWORK: names.network,
    IMP_DEV_IP: network.ipA,
  };
}

export interface HostBFixture {
  readonly start: () => Promise<void>;

  readonly reset: () => Promise<void>;

  readonly stop: () => Promise<void>;
}

export interface HostBFixtureDeps {
  readonly cliDir: string;
  readonly removeLeftovers: () => Promise<void>;
  readonly createNetwork: (name: string, network: Readonly<MoveNetwork>) => Promise<void>;
  readonly connectHeadscale: (network: string) => Promise<void>;

  readonly startHost: (host: Readonly<DevInstance>) => Promise<void>;

  readonly login: (
    host: Readonly<DevInstance>,
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;

  readonly resetHost: (host: Readonly<DevInstance>, prefix: string) => Promise<void>;

  readonly removeHost: (host: Readonly<DevInstance>) => Promise<void>;
  readonly keep: boolean;
  readonly log: (line: string) => void;
}

// env is the harness's: B starts with its host image and its tailnet key, and
// never with a key the harness withheld.
export function buildHostBFixtureDeps(keep: boolean, env: HarnessEnv): HostBFixtureDeps {
  return {
    cliDir: buildNames().cliDir,
    keep,
    removeLeftovers: () => removeMoveLeftovers(env),
    connectHeadscale: (network) => connectHeadscale({ runCommand, runChecked }, network),
    createNetwork: async (name, network) => {
      await runChecked([
        'docker',
        'network',
        'create',
        '--subnet',
        network.subnet,
        '--gateway',
        network.gateway,
        name,
      ]);
    },
    startHost: async (host) => {
      await runDevScript('up', host, {}, env);
      await checkPrivileges(host, readTextOrNull);
    },
    login: async (host, cliEnv) => {
      const token = await readToken(host);

      await runImpWith(
        { stdin: `${token}\n`, env: cliEnv },
        'login',
        host.apiUrl,
        '--name',
        HOST_B,
      );
    },
    resetHost: async (host, prefix) => {
      const client = await createInstanceClient(host);

      await resetBaseline({ client, prefixes: [prefix], dataDir: host.dataDir });
    },
    removeHost: async (host) => {
      const target = await resolveDataWipe(host.dataDir, env, pickHostBZfsRoot(env));

      await runDevScript('down', host, {}, env);

      if (target !== null) {
        await removeDataDir(target, env, host.containerCLI);
      }
    },
    log: (line) => {
      console.error(line);
    },
  };
}

export function createHostBFixture(
  options: Readonly<MoveHostsOptions>,
  prefix: string,
  deps: Readonly<HostBFixtureDeps>,
): HostBFixture {
  const names = buildNames();
  const hostB = readHostB(options);
  const reset = () => deps.resetHost(hostB, prefix);

  const startLoggedIn = async () => {
    await deps.startHost(hostB);

    rmSync(deps.cliDir, { recursive: true, force: true });
    mkdirSync(deps.cliDir, { recursive: true });

    await deps.login(hostB, { XDG_CONFIG_HOME: deps.cliDir });
  };

  return {
    start: async () => {
      await deps.removeLeftovers();
      await deps.createNetwork(names.network, buildMoveNetwork(readOffset()));

      if (options.tailnet === 'headscale') {
        await deps.connectHeadscale(names.network);
      }

      await startLoggedIn();

      // A reset that fails makes B from nothing: a receiving imp whose source is
      // gone stays marked, and impd refuses to remove it.
      try {
        await reset();
      } catch (error) {
        if (deps.keep) {
          throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);

        deps.log(`    ${hostB.container} could not be reset, so it starts from nothing: ${reason}`);

        await deps.removeHost(hostB);

        await startLoggedIn();
        await reset();
      }
    },
    reset,
    stop: async () => {
      await deps.removeLeftovers();

      rmSync(deps.cliDir, { recursive: true, force: true });
    },
  };
}

export function readMoveHosts(options: Readonly<MoveHostsOptions>): MoveHosts {
  const names = buildNames();

  return {
    hostA: instance,
    hostB: readHostB(options),
    network: names.network,
    gateway: buildMoveNetwork(readOffset()).gateway,
    cliEnv: { XDG_CONFIG_HOME: names.cliDir },
  };
}
