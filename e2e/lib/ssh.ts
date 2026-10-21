import { onTestFinished } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult } from './instance';
import { REPO_ROOT, instance, runChecked, runCommand, runInContainer } from './instance';
import { waitFor } from './wait-for';

export const SSH_HOST = 'imp-e2e';
export const SSH_HOST_OTHER_KEY = 'imp-e2e-other-key';
const KEY_COMMENT = 'imp-e2e-ssh-suite';
const AUTHORIZED_KEYS = '/var/lib/imp/ssh/authorized_keys';

export interface SshClient {
  readonly configArgs: readonly string[];

  readonly directory: string;
  readonly cleanup: () => Promise<void>;
}

async function createKey(path: string, comment: string): Promise<string> {
  await runChecked(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path]);

  return Bun.file(`${path}.pub`).text();
}

// Before any Host block: OpenSSH applies IgnoreUnknown only in a block that
// matches, but rejects an unknown option in every block it reads.
const IGNORE_UNKNOWN = 'IgnoreUnknown WarnWeakCrypto';

function buildHostBlock(directory: string, alias: string, identity: string): string[] {
  return [
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  Port ${String(instance.sshPort)}`,
    `  IdentityFile ${identity}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${join(directory, 'known_hosts')}`,
    '  StrictHostKeyChecking accept-new',
    '  BatchMode yes',
    '  LogLevel ERROR',

    // OpenSSH warns of a key exchange without post-quantum safety, which ssh2
    // cannot offer.
    '  WarnWeakCrypto no',
  ];
}

export interface KeyClient extends SshClient {
  readonly publicKeyPaths: ReadonlyMap<string, string>;
}

export async function setupKeyClient(aliases: readonly string[]): Promise<KeyClient> {
  const scratch = join(REPO_ROOT, '.cache', 'e2e');

  mkdirSync(scratch, { recursive: true });

  const directory = mkdtempSync(join(scratch, 'ssh-keys-'));
  const config = join(directory, 'config');

  const publicKeyPaths = new Map<string, string>();

  const blocks: string[] = [];

  for (const alias of aliases) {
    const key = join(directory, alias);

    await createKey(key, alias);

    publicKeyPaths.set(alias, `${key}.pub`);
    blocks.push(...buildHostBlock(directory, alias, key));
  }

  writeFileSync(config, [IGNORE_UNKNOWN, ...blocks, ''].join('\n'));

  return {
    configArgs: ['-F', config],
    directory,
    publicKeyPaths,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}

export async function setupSshClient(): Promise<SshClient> {
  const scratch = join(REPO_ROOT, '.cache', 'e2e');

  mkdirSync(scratch, { recursive: true });

  const directory = mkdtempSync(join(scratch, 'ssh-'));
  const key = join(directory, 'id');
  const otherKey = join(directory, 'other');
  const config = join(directory, 'config');

  const publicKey = await createKey(key, KEY_COMMENT);

  await createKey(otherKey, 'not-authorized');

  const added = await runInContainer([
    'sh',
    '-c',
    `umask 077 && touch ${AUTHORIZED_KEYS} && sed -i '/${KEY_COMMENT}/d' ${AUTHORIZED_KEYS} && printf '%s' "$0" >> ${AUTHORIZED_KEYS}`,
    publicKey,
  ]);

  if (added.exitCode !== 0) {
    throw new Error(`could not authorize the suite's key: ${added.stderr.trim()}`);
  }

  writeFileSync(
    config,
    [
      IGNORE_UNKNOWN,
      ...buildHostBlock(directory, SSH_HOST, key),
      ...buildHostBlock(directory, SSH_HOST_OTHER_KEY, otherKey),
      '',
    ].join('\n'),
  );

  return {
    configArgs: ['-F', config],
    directory,
    cleanup: async () => {
      await runInContainer(['sed', '-i', `/${KEY_COMMENT}/d`, AUTHORIZED_KEYS]);

      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function runSsh(
  client: SshClient,
  user: string,
  args: readonly string[],
  options: Readonly<{ stdin?: string; host?: string; env?: Readonly<Record<string, string>> }> = {},
): Promise<CommandResult> {
  const host = options.host ?? SSH_HOST;

  return runCommand(['ssh', ...client.configArgs, `${user}@${host}`, ...args], options);
}

export function startSsh(
  client: SshClient,
  args: readonly string[],
  stdin?: string,
  env: Readonly<Record<string, string>> = {},
) {
  const subprocess = Bun.spawn(['ssh', ...client.configArgs, ...args], {
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });

  return {
    childProcess: subprocess,
    stop: async () => {
      subprocess.kill();

      await subprocess.exited;
    },
  };
}

export interface ForwardedList {
  readonly listed: CommandResult;

  readonly forwardLog: string;
}

// `local` must fit a unix socket path (107 bytes).
export async function listAgentThroughUnixForward(
  client: SshClient,
  user: string,
  guestPath: string,
  local: string,
): Promise<ForwardedList> {
  // INFO: the client logs a refused channel at that level
  const forward = startSsh(client, [
    '-N',
    '-o',
    'LogLevel=INFO',
    '-L',
    `${local}:${guestPath}`,
    `${user}@${SSH_HOST}`,
  ]);

  onTestFinished(async () => {
    await forward.stop();

    rmSync(local, { force: true });
  });

  // The client listens once it has logged in, which may wake the imp.
  await waitFor(`the forward to listen on ${local}`, () => {
    if (!existsSync(local)) {
      throw new Error(`no ${local} yet`);
    }
  });

  const result = await runCommand(['ssh-add', '-l'], { env: { SSH_AUTH_SOCK: local } });

  await forward.stop();

  rmSync(local, { force: true });

  const forwardLog = await new Response(forward.childProcess.stderr).text();

  return { listed: result, forwardLog };
}

export interface LocalSshAgent {
  readonly socket: string;
  readonly publicKey: string;

  readonly keyPath: string;

  readonly stop: () => Promise<void>;
}

// The shell runs the agent until its stdin closes: when the suite's process
// ends, even without afterAll, the pipe closes and the agent goes with it.
const AGENT_WRAPPER = 'ssh-agent -D -a "$1" & agent=$!; cat >/dev/null; kill "$agent"';

// The socket sits in a dir of its own under TMPDIR: a unix socket path holds
// 107 bytes, which a dir in a worktree's .cache can pass.
export async function startLocalSshAgent(
  client: SshClient,
  label = 'laptop',
): Promise<LocalSshAgent> {
  const sockets = mkdtempSync(join(tmpdir(), 'imp-agent-'));
  const socket = join(sockets, `${label}.sock`);
  const keyPath = join(client.directory, `${label}-key`);

  const publicKey = await createKey(keyPath, `imp-e2e-${label}`);

  const agent = Bun.spawn(['sh', '-c', AGENT_WRAPPER, 'sh', socket], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForSocket(socket);
  await runCommand(['ssh-add', '-q', keyPath], { env: { SSH_AUTH_SOCK: socket } });

  return {
    socket,
    publicKey,
    keyPath,
    stop: async () => {
      await agent.stdin.end();

      await agent.exited;

      rmSync(sockets, { recursive: true, force: true });
    },
  };
}

async function waitForSocket(path: string): Promise<void> {
  await waitFor(
    `ssh-agent to make ${path}`,
    () => {
      if (!existsSync(path)) {
        throw new Error('no socket yet');
      }
    },
    { intervalMs: 20, timeoutMs: 5000 },
  );
}

export async function readTapLinkLocal(hostIp: string): Promise<string> {
  const v4 = await runInContainer(['ip', '-o', '-4', 'addr', 'show', 'to', hostIp]);

  const tap = /^\d+: (?<tap>\S+)/u.exec(v4.stdout)?.groups?.['tap'];

  if (tap === undefined) {
    throw new Error(`no interface has ${hostIp}: ${v4.stdout}${v4.stderr}`);
  }

  const v6 = await runInContainer(['ip', '-o', '-6', 'addr', 'show', 'dev', tap, 'scope', 'link']);

  const linkLocal = /inet6 (?<ip>[\da-f:]+)/u.exec(v6.stdout)?.groups?.['ip'];

  if (linkLocal === undefined) {
    throw new Error(`${tap} has no link-local address: ${v6.stdout}${v6.stderr}`);
  }

  return linkLocal;
}
