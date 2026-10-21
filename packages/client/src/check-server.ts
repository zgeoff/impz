import type { ImpContract, SystemInfo } from '@impz/api';
import type { ContractRouterClient } from '@orpc/contract';
import packageJson from '../package.json' with { type: 'json' };

// The bundler inlines it, so a published build knows its own version.
export const CLIENT_VERSION = packageJson.version;

export interface ServerCheck {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly compatible: boolean;
  readonly info: SystemInfo;
}

export interface CheckServerOptions {
  readonly signal?: Readonly<AbortSignal>;
}

export async function checkServer(
  rpc: Readonly<ContractRouterClient<ImpContract>>,
  options: Readonly<CheckServerOptions> = {},
): Promise<ServerCheck> {
  const signal = options.signal;
  const callOptions = signal === undefined ? {} : { signal };

  const info = await rpc.system.info(undefined, callOptions);

  return {
    clientVersion: CLIENT_VERSION,
    serverVersion: info.version,
    compatible: isCompatibleVersion(CLIENT_VERSION, info.version),
    info,
  };
}

// The client and impd release together. A major change breaks the API, and
// before 1.0 a minor change does too, because release-please bumps the minor
// for a feat before 1.0.
export function isCompatibleVersion(client: string, server: string): boolean {
  const ours = parseVersion(client);
  const theirs = parseVersion(server);

  if (ours === null || theirs === null || ours.major !== theirs.major) {
    return false;
  }

  return ours.major > 0 || ours.minor === theirs.minor;
}

function parseVersion(version: string): { major: number; minor: number } | null {
  const groups = /^(?<major>\d+)\.(?<minor>\d+)\.\d+/u.exec(version)?.groups;

  return groups === undefined
    ? null
    : { major: Number(groups['major']), minor: Number(groups['minor']) };
}
