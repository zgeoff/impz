import { join, resolve } from 'node:path';
import { DevError } from './dev-error.ts';

export type DevEnv = Readonly<Record<string, string | undefined>>;

export interface DevLayout {
  readonly name: string;
  readonly proxy: string;
  readonly dataDir: string;
  readonly offset: number;
  readonly isPublished: boolean;
  readonly apiURL: string;
  readonly apiPort: number;
  readonly proxyPort: number;
  readonly impPortBase: number;
  readonly sshPort: number;
  readonly mcpPort: number;
}

interface DevLayoutOptions {
  readonly env: DevEnv;
  readonly root: string;
  readonly cwd: string;
}

const API_PORT = 7070;
const PROXY_PORT = 7080;
const MCP_PORT = 7071;
const SSH_PORT = 2222;
const IMP_PORT_BASE = 20_000;

export function buildDevLayout(options: DevLayoutOptions): DevLayout {
  const name = pickSetting(options.env, 'IMP_DEV_NAME') ?? 'imp-dev';
  const offsetSetting = pickSetting(options.env, 'IMP_DEV_PORT_OFFSET') ?? '0';
  const offset = Number(offsetSetting);

  if (!Number.isInteger(offset) || offset < 0) {
    throw new DevError(`IMP_DEV_PORT_OFFSET must be a whole number, got '${offsetSetting}'`);
  }

  const isPublished = options.env['IMP_DEV_PUBLISH'] !== '0';
  const ip = pickSetting(options.env, 'IMP_DEV_IP');

  if (!isPublished && ip === undefined) {
    throw new DevError('IMP_DEV_PUBLISH=0 needs IMP_DEV_IP');
  }

  const dataSetting =
    pickSetting(options.env, 'IMP_DEV_DATA') ?? join(options.root, '.data', 'dev');

  const apiURL = isPublished
    ? `http://localhost:${String(API_PORT + offset)}`
    : `http://${ip ?? ''}:${String(API_PORT)}`;

  return {
    name,
    proxy: `${name}-docker-proxy`,
    dataDir: resolve(options.cwd, dataSetting),
    offset,
    isPublished,
    apiURL,
    apiPort: API_PORT + offset,
    proxyPort: PROXY_PORT + offset,
    impPortBase: IMP_PORT_BASE + offset,
    sshPort: SSH_PORT + offset,
    mcpPort: MCP_PORT + offset,
  };
}

function pickSetting(env: DevEnv, key: string): string | undefined {
  const value = env[key];

  return value === undefined || value === '' ? undefined : value;
}
