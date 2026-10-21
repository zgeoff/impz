import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { UsageError } from '../cli/errors';
import { updateLegacyConfig } from './update-legacy-config';

export type CliEnv = Readonly<Record<string, string | undefined>>;

interface SavedHost {
  readonly url: string;
  readonly token: string | null;
}

export interface HostConfig {
  readonly current: string | null;
  readonly hosts: Readonly<Record<string, SavedHost>>;
}

const SavedHostSchema = z.object({ url: z.string(), token: z.string().nullable() });

const HostConfigSchema = z.object({
  current: z.string().nullable().default(null),
  hosts: z.record(z.string(), SavedHostSchema).default({}),
});

// a shell and a completion script take the name as one word, and a URL never
// matches, so `--host https://…` is caught as a mistake
const HOST_NAME = /^[a-z0-9][a-z0-9._-]*$/iu;
const EMPTY_CONFIG: HostConfig = { current: null, hosts: {} };

// the saved hosts need only their own file: a fallback token that cannot
// move stays behind, for the call that reads it
const HOST_FILES: readonly string[] = ['config.json'];

export function resolveConfigDir(env: CliEnv): string {
  const configHome = env['XDG_CONFIG_HOME'] ?? join(env['HOME'] ?? homedir(), '.config');

  return join(configHome, 'impz');
}

/* @internal */
export function resolveConfigPath(env: CliEnv): string {
  return join(resolveConfigDir(env), 'config.json');
}

export function checkHostName(name: string): string {
  if (!HOST_NAME.test(name)) {
    throw new UsageError(
      `not a host name: ${name} (letters, digits, '.', '_' and '-'; a URL goes to impz login)`,
    );
  }

  return name;
}

export function readHostConfig(
  env: CliEnv,
  warn: (line: string) => void = console.error,
): HostConfig {
  updateLegacyConfig(resolveConfigDir(env), warn, HOST_FILES);

  const path = resolveConfigPath(env);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return EMPTY_CONFIG;
    }

    throw error;
  }

  checkSharedMode(path, warn);

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not valid JSON; fix or remove it`);
  }

  const result = HostConfigSchema.safeParse(parsed);

  if (!result.success) {
    throw new UsageError(`${path} is not an impz config (${z.prettifyError(result.error)})`);
  }

  return result.data;
}

export function writeHostConfig(
  env: CliEnv,
  config: HostConfig,
  warn: (line: string) => void = console.error,
): void {
  updateLegacyConfig(resolveConfigDir(env), warn, HOST_FILES);
  mkdirSync(resolveConfigDir(env), { recursive: true, mode: 0o700 });

  // a symlinked config.json (dotfiles) stays a link: the rename replaces
  // the file it points at
  const path = resolveWritePath(resolveConfigPath(env));
  const temp = `${path}.${String(process.pid)}.tmp`;

  // `wx` creates the file, so the mode applies; a temp file a crash left
  // behind could carry another mode, so it goes first
  rmSync(temp, { force: true });

  const fd = openSync(temp, 'wx', 0o600);

  // synced before the rename, so a crash never leaves an empty config
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temp, path);
}

function resolveWritePath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return path;
    }

    throw error;
  }
}

function checkSharedMode(path: string, warn: (line: string) => void): void {
  if ((statSync(path).mode & 0o077) !== 0) {
    warn(`impz: warning: ${path} is readable by other users; run chmod 600 ${path}`);
  }
}
