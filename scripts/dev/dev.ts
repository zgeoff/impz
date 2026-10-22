import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { match } from 'ts-pattern';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import type { DevEnv } from '../lib/build-dev-layout.ts';
import { createHostImage } from '../lib/create-host-image.ts';
import { DevError } from '../lib/dev-error.ts';
import { makeOpReader } from '../lib/make-op-reader.ts';
import type { OpReader } from '../lib/make-op-reader.ts';
import { readDevCheckout } from '../lib/read-dev-checkout.ts';
import { readHostPrivileges } from '../lib/read-host-privileges.ts';
import { readMachineID } from '../lib/read-machine-id.ts';
import { readTailscaleAuthkey } from '../lib/read-tailscale-authkey.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { writeTailnetOAuthFile } from '../lib/write-tailnet-oauth-file.ts';
import { buildHostRunArgs } from './build-host-run-args.ts';
import type { TailscaleArg } from './build-host-run-args.ts';
import { probeContainerRunning } from './probe-container-running.ts';
import { pruneDevImages } from './prune-dev-images.ts';
import { readLogTail } from './read-log-tail.ts';
import { startDevProxy } from './start-dev-proxy.ts';
import type { Dev } from './types.ts';
import { waitDevReady } from './wait-dev-ready.ts';

const USAGE = 'usage: scripts/dev/dev.sh up|down|reboot|logs|restart|shell|token|prune';
const UP_READY_S = 600;
const RESTART_READY_S = 60;
const STOP_POLL_MS = 200;

// docs/guides/configuration.md#dev-instance lists the settings this reads.
export async function runDev(argv: readonly string[], env: DevEnv): Promise<number> {
  try {
    const layout = buildDevLayout({ env, root: REPO_ROOT, cwd: process.cwd() });
    const dev: Dev = { env, layout, checkout: readDevCheckout(env, REPO_ROOT) };

    return await dispatchDev(dev, argv[0] ?? '');
  } catch (error) {
    if (error instanceof DevError) {
      process.stderr.write(`dev.sh: ${error.message}\n${error.detail}`);

      return 1;
    }

    if (error instanceof $.ShellError) {
      return error.exitCode;
    }

    throw error;
  }
}

function dispatchDev(dev: Dev, command: string): Promise<number> {
  return match(command)
    .with('up', async () => {
      await upDev(dev);

      return 0;
    })
    .with('down', async () => {
      await downDev(dev);

      return 0;
    })
    .with('reboot', async () => {
      await downDev(dev);
      await upDev(dev);

      return 0;
    })
    .with('logs', () => runAttached(['docker', 'logs', '-f', dev.layout.name]))
    .with('restart', async () => {
      await restartDev(dev);

      return 0;
    })
    .with('shell', () => runAttached(['docker', 'exec', '-it', dev.layout.name, 'bash']))
    .with('token', () =>
      runAttached(['docker', 'exec', dev.layout.name, 'cat', '/var/lib/imp/token']),
    )
    .with('prune', async () => {
      await pruneDevImages(dev);

      return 0;
    })
    .otherwise(() => {
      process.stderr.write(`${USAGE}\n`);

      return Promise.resolve(2);
    });
}

async function upDev(dev: Dev): Promise<void> {
  const drives = await prepareDrives(dev);
  const isRunning = await probeContainerRunning(dev.layout.name);

  const proxyMode = isRunning ? 'keep' : 'replace';

  await startDevProxy(dev, proxyMode);

  if (isRunning) {
    console.log(`dev.sh: ${dev.layout.name} already running`);
  } else {
    await startHost(dev, drives);

    console.log(`dev.sh: started ${dev.layout.name}`);
  }

  await waitDevReady(dev, UP_READY_S);

  console.log(`dev.sh: impd ready on ${dev.layout.apiURL} (token: scripts/dev/dev.sh token)`);

  console.log(
    `dev.sh: dashboard on ${dev.layout.apiURL}/ui/ (bun run build:dashboard to build it)`,
  );
}

interface Drives {
  readonly kernel: string;
  readonly systemDrive: string;
}

async function prepareDrives(dev: Dev): Promise<Drives> {
  const kernel = resolveKernel(dev.env, dev.checkout.root);
  const systemSetting = dev.env['IMP_SYSTEM_DRIVE'] ?? '';
  const systemDrive = systemSetting || join(dev.checkout.buildDir, 'imp-system.squashfs');

  if (!existsSync(kernel)) {
    throw new DevError(`no kernel at ${kernel}`);
  }

  await prepareHostImage(dev);

  // The docker cache makes this a no-op when the agent is unchanged.
  if (systemSetting === '') {
    const script = join(dev.checkout.root, 'scripts', 'release', 'build-system-drive.sh');

    await $`${script} > /dev/null`;
  }

  if (!existsSync(systemDrive)) {
    throw new DevError(`no system drive at ${systemDrive}`);
  }

  return { kernel, systemDrive };
}

function resolveKernel(env: DevEnv, root: string): string {
  const built = join(root, 'kernel', 'out', 'vmlinux');
  const setting = env['IMP_KERNEL'] ?? '';

  if (setting !== '') {
    return setting;
  }

  return existsSync(built) ? built : join(root, '.cache', 'vmlinux-ci');
}

// CI builds and loads the image first, with its own cache, and sets IMP_HOST_IMAGE_READY=1.
async function prepareHostImage(dev: Dev): Promise<void> {
  if (dev.env['IMP_HOST_IMAGE_READY'] !== '1') {
    await createHostImage(dev.checkout, readMachineID(dev.env).id);

    return;
  }

  const inspect = await $`docker image inspect ${dev.checkout.hostImage}`.quiet().nothrow();

  if (inspect.exitCode !== 0) {
    throw new DevError(`IMP_HOST_IMAGE_READY=1 but there is no ${dev.checkout.hostImage} image`);
  }
}

async function startHost(dev: Dev, drives: Drives): Promise<void> {
  const readOp = makeOpReader(dev.env);

  await $`docker rm -f ${dev.layout.name}`.quiet().nothrow();

  mkdirSync(dev.layout.dataDir, { recursive: true });

  const tailscale = await readHostTailscale(dev, readOp);
  const tailnetOAuthFile = await writeHostOAuthFile(dev, readOp);

  const acmeSetting = dev.env['IMP_ACME_CA_FILE'] ?? '';

  const acmeCAFile =
    acmeSetting === '' ? null : resolveContainerPath(dev.checkout.root, acmeSetting);

  const uplinkSetting = dev.env['IMP_UPLINK_MTU'] ?? '';
  const uplinkMTU = uplinkSetting === '' ? await readUplinkMTU() : uplinkSetting;

  const args = buildHostRunArgs({
    layout: dev.layout,
    checkout: dev.checkout,
    env: tailscale.env,
    privileges: readHostPrivileges(dev.checkout.root),
    hasEnvFile: existsSync(join(dev.checkout.root, '.env')),
    tailscale: tailscale.arg,
    tailnetOAuthFile,
    acmeCAFile,
    kernel: resolveContainerPath(dev.checkout.root, drives.kernel),
    systemDrive: resolveContainerPath(dev.checkout.root, drives.systemDrive),
    uplinkMTU,
  });

  // docker reads .env and the key from its own environment, so no secret is in its argv.
  await $`docker ${args} > /dev/null`.env(toProcessEnv(tailscale.env));
}

interface HostTailscale {
  readonly arg: TailscaleArg;
  readonly env: DevEnv;
}

async function readHostTailscale(dev: Dev, readOp: OpReader | null): Promise<HostTailscale> {
  if (dev.env['IMP_DEV_TAILNET'] === '0') {
    return { arg: 'off', env: dev.env };
  }

  const authkey = await readTailscaleAuthkey({
    env: dev.env,
    root: dev.checkout.root,
    readOp,
    warn: writeWarning,
  });

  if (authkey === null) {
    return { arg: 'none', env: dev.env };
  }

  const tags = authkey.tags === null ? {} : { IMP_TAILSCALE_TAGS: authkey.tags };

  return { arg: 'key', env: { ...dev.env, TAILSCALE_AUTHKEY: authkey.key, ...tags } };
}

function writeWarning(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function writeHostOAuthFile(dev: Dev, readOp: OpReader | null): Promise<string | null> {
  if (dev.env['IMP_TAILNET_NAMES'] !== '1') {
    return null;
  }

  const isWritten = await writeTailnetOAuthFile({
    file: join(dev.layout.dataDir, 'tailnet-oauth.json'),
    env: dev.env,
    readOp,
    warn: writeWarning,
  });

  if (!isWritten) {
    throw new DevError('IMP_TAILNET_NAMES=1 but 1Password has no OAuth client');
  }

  return '/data/tailnet-oauth.json';
}

function resolveContainerPath(root: string, path: string): string {
  const absolute = resolve(path);

  if (!absolute.startsWith(`${root}/`)) {
    throw new DevError(`${path} is not under ${root}`);
  }

  return `/src/${absolute.slice(root.length + 1)}`;
}

// The container's own eth0 claims 1500 whatever the real path allows.
async function readUplinkMTU(): Promise<string> {
  const route = await $`ip route show default`.quiet().nothrow();

  const device = route.stdout.toString().split(/\s+/u)[4] ?? '';

  try {
    return readFileSync(`/sys/class/net/${device}/mtu`, 'utf8').trim();
  } catch {
    return '1500';
  }
}

function toProcessEnv(env: DevEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

// SIGTERM gives impd time to sleep every imp, so memory survives.
async function downDev(dev: Dev): Promise<void> {
  const isRunning = await probeContainerRunning(dev.layout.name);

  if (isRunning) {
    await $`docker stop -t 120 ${dev.layout.name} > /dev/null`;

    const tail = await readLogTail(dev.layout.name, 5);

    for (const line of tail.split('\n').filter((entry) => entry.includes('every imp asleep'))) {
      console.log(line);
    }
  }

  const volumes = [`${dev.layout.name}-docker`, `${dev.layout.name}-docker-proxy`];

  await $`docker rm -f ${dev.layout.name} ${dev.layout.proxy}`.quiet().nothrow();
  await $`docker volume rm ${volumes}`.quiet().nothrow();
}

async function runAttached(argv: readonly string[]): Promise<number> {
  const subprocess = Bun.spawn([...argv], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return await subprocess.exited;
}

// SIGHUP: impd exits without sleeping the VMs, and the entrypoint restarts it. The wait for the old
// pid to go makes /health answer from the new impd.
async function restartDev(dev: Dev): Promise<void> {
  const isRunning = await probeContainerRunning(dev.layout.name);

  if (!isRunning) {
    throw new DevError(`${dev.layout.name} is not running; use scripts/dev/dev.sh up`);
  }

  await startDevProxy(dev, 'replace');

  const pattern = 'bun .*/daemon/src/main.ts';

  const found = await $`docker exec ${dev.layout.name} pgrep -f ${pattern}`.quiet().nothrow();

  const pids = found.stdout
    .toString()
    .split('\n')
    .filter((pid) => pid !== '');

  if (pids.length > 0) {
    await $`docker exec ${dev.layout.name} kill -HUP ${pids}`;
    await waitForExit(dev, pids);
  }

  await waitDevReady(dev, RESTART_READY_S);
}

async function waitForExit(dev: Dev, pids: readonly string[]): Promise<void> {
  const stopSeconds = Number(dev.env['IMP_DEV_STOP_TIMEOUT_S'] || '30');
  const deadline = Date.now() + stopSeconds * 1000;

  for (;;) {
    const alive = await $`docker exec ${dev.layout.name} kill -0 ${pids}`.quiet().nothrow();

    if (alive.exitCode !== 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new DevError(`impd ${pids.join(' ')} did not exit`);
    }

    await Bun.sleep(STOP_POLL_MS);
  }
}

if (import.meta.main) {
  const exitCode = await runDev(process.argv.slice(2), process.env);

  process.exit(exitCode);
}
