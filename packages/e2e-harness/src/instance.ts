import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { buildDevLayout } from '../../../scripts/lib/build-dev-layout.ts';
import type { ContainerCLI } from '../../../scripts/lib/build-dev-layout.ts';
import { readDevCheckout } from '../../../scripts/lib/read-dev-checkout.ts';
import { config } from './config';
import type { HarnessEnv } from './config';
import { buildFirecrackerPgrepArgv, readFirecrackerPids } from './firecracker-pids';

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'e2e', 'fixtures');
const DEV_SCRIPT = join(REPO_ROOT, 'scripts', 'dev', 'dev.sh');

export interface DevInstance {
  readonly container: string;
  readonly containerCLI: ContainerCLI;

  readonly dataDir: string;
  readonly apiUrl: string;
  readonly proxyPort: number;
  readonly impPortBase: number;

  readonly sshPort: number;

  readonly portOffset: number;

  readonly env: Readonly<Record<string, string>>;

  readonly token: string | null;
}

export function buildInstance(env: HarnessEnv, cwd: string): DevInstance {
  const layout = buildDevLayout({ env, root: REPO_ROOT, cwd });

  // With the default name, an offset run would drive and wipe imp-dev, not its
  // own instance.
  if (layout.offset !== 0 && (env['IMP_DEV_NAME'] ?? '') === '') {
    throw new Error('IMP_DEV_PORT_OFFSET needs IMP_DEV_NAME: name the instance it belongs to');
  }

  const token = env['IMP_TOKEN'] ?? '';

  return {
    container: layout.name,
    containerCLI: layout.containerCLI,
    dataDir: layout.dataDir,
    apiUrl: env['IMP_URL'] ?? layout.apiURL,
    proxyPort: layout.proxyPort,
    impPortBase: layout.impPortBase,
    sshPort: layout.sshPort,

    portOffset: layout.offset,
    env: {},
    token: token === '' ? null : token,
  };
}

export const instance = buildInstance(process.env, process.cwd());

export interface InstanceOptions {
  readonly container: string;
  readonly dataDir: string;

  readonly network: string;
  readonly ip: string;

  readonly env?: Readonly<Record<string, string>>;
}

// The second host joins a network that the host's Docker makes, so it always runs under docker.
export function createInstance(options: InstanceOptions): DevInstance {
  return {
    container: options.container,
    containerCLI: 'docker',
    dataDir: options.dataDir,
    apiUrl: `http://${options.ip}:7070`,
    proxyPort: 7080,
    impPortBase: 20_000,
    sshPort: 22,
    portOffset: 0,
    token: null,
    env: {
      ...options.env,
      IMP_DEV_NAME: options.container,
      IMP_DEV_CONTAINER_CLI: 'docker',
      IMP_DEV_DATA: options.dataDir,
      IMP_DEV_PORT_OFFSET: '0',
      IMP_DEV_NETWORK: options.network,
      IMP_DEV_IP: options.ip,
      IMP_DEV_PUBLISH: '0',
    },
  };
}

const HealthSchema = z.object({ ready: z.boolean() });

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCommand(
  argv: readonly string[],
  options: Readonly<{ stdin?: string; env?: Readonly<Record<string, string>> }> = {},
): Promise<CommandResult> {
  const subprocess = Bun.spawn([...argv], {
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}

export async function runChecked(argv: readonly string[]): Promise<string> {
  const result = await runCommand(argv);

  if (result.exitCode !== 0) {
    const output = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();

    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${output}`);
  }

  return result.stdout;
}

export interface CommandRunners {
  readonly runCommand: typeof runCommand;
  readonly runChecked: typeof runChecked;
}

export function readHostImage(env: HarnessEnv): string {
  return readDevCheckout(realpathSync, env, REPO_ROOT).hostImage;
}

export function readHostImageFromEnv(env: HarnessEnv = process.env): string {
  const image = env['IMP_HOST_IMAGE'] ?? '';

  if (image === '') {
    throw new Error('IMP_HOST_IMAGE is not set: run the suites through e2e/test-e2e.sh');
  }

  return image;
}

export async function runDevScript(
  command: string,
  target: DevInstance = instance,
  settings: Readonly<Record<string, string>> = {},
  env: HarnessEnv = process.env,
): Promise<void> {
  const subprocess = Bun.spawn([DEV_SCRIPT, command], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      IMP_RAM_BUDGET_MIB: String(config.ramBudgetMib),
      IMP_IDLE_TIMEOUT_S: String(config.idleTimeoutS),
      ...env,
      ...target.env,
      ...settings,
    },
  });

  const exitCode = await subprocess.exited;

  if (exitCode !== 0) {
    throw new Error(`scripts/dev/dev.sh ${command} exited ${String(exitCode)}`);
  }
}

export async function readToken(target: DevInstance = instance): Promise<string> {
  const result = await runCommand([DEV_SCRIPT, 'token'], { env: target.env });

  if (result.exitCode !== 0) {
    throw new Error(`scripts/dev/dev.sh token exited ${String(result.exitCode)}: ${result.stderr}`);
  }

  return result.stdout.trim();
}

export function runInContainer(
  argv: readonly string[],
  target: DevInstance = instance,
): Promise<CommandResult> {
  return runCommand([target.containerCLI, 'exec', target.container, ...argv]);
}

// Guests reach this machine through FORWARD and MASQUERADE. Egress policies
// must keep that route open, or the ssh-agent suite cannot reach its git server.
export async function readContainerGateway(): Promise<string> {
  const route = await runInContainer(['ip', '-4', 'route', 'show', 'default']);

  const gateway = /via (?<ip>[\d.]+)/u.exec(route.stdout)?.groups?.['ip'];

  if (gateway === undefined) {
    throw new Error(`no default route in ${instance.container}: ${route.stdout}`);
  }

  return gateway;
}

export async function readImpdLogTail(
  lines: number,
  target: Readonly<DevInstance> = instance,
): Promise<string> {
  const result = await runCommand([
    target.containerCLI,
    'logs',
    '--timestamps',
    '--tail',
    String(lines),
    target.container,
  ]);

  return `${result.stdout}${result.stderr}`;
}

export async function readImpdLogSince(
  since: Readonly<Date>,
  target: Readonly<DevInstance> = instance,
): Promise<string> {
  const argv = [target.containerCLI, 'logs', '--since', since.toISOString(), target.container];

  const result = await runCommand(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return `${result.stdout}${result.stderr}`;
}

export async function readImpdLoggedMs(text: string): Promise<number | null> {
  const result = await runCommand([instance.containerCLI, 'logs', instance.container]);

  const lines = `${result.stdout}${result.stderr}`
    .split('\n')
    .filter((line) => line.includes(text));

  const match = /in (?<ms>\d+)ms$/u.exec(lines.at(-1)?.trim() ?? '');
  const durationMs = match?.groups?.['ms'];

  return durationMs === undefined ? null : Number(durationMs);
}

export async function checkFirecrackerRunning(id: string): Promise<boolean> {
  const result = await runInContainer(buildFirecrackerPgrepArgv(id));

  return result.exitCode === 0;
}

export async function stopFirecrackerHard(id: string): Promise<void> {
  const found = await runInContainer(buildFirecrackerPgrepArgv(id));

  const pids = readFirecrackerPids(id, found.stdout);

  await runChecked([instance.containerCLI, 'exec', instance.container, 'kill', '-9', ...pids]);
}

export async function readImpdPid(): Promise<string | null> {
  const result = await runInContainer(['pgrep', '-f', 'bun .*/daemon/src/main.ts']);

  const pid = result.stdout.split('\n')[0]?.trim() ?? '';

  return pid === '' ? null : pid;
}

export async function checkHealthReady(target: DevInstance = instance): Promise<boolean> {
  try {
    const response = await fetch(`${target.apiUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    const body: unknown = await response.json();

    const health = HealthSchema.safeParse(body);

    return response.ok && health.success && health.data.ready;
  } catch {
    return false;
  }
}
