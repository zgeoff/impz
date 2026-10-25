import { join } from 'node:path';
import { $ } from 'bun';
import { match } from 'ts-pattern';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import type { DevEnv } from '../lib/build-dev-layout.ts';
import { createHostImage } from '../lib/create-host-image.ts';
import { DevError } from '../lib/dev-error.ts';
import type { OpReader } from '../lib/make-op-reader.ts';
import { parseSecondsSetting } from '../lib/parse-seconds-setting.ts';
import { readDevCheckout } from '../lib/read-dev-checkout.ts';
import { readHostPrivileges } from '../lib/read-host-privileges.ts';
import { readMachineID } from '../lib/read-machine-id.ts';
import { readTailscaleAuthkey } from '../lib/read-tailscale-authkey.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { toProcessEnv } from '../lib/to-process-env.ts';
import { writeTailnetOAuthFile } from '../lib/write-tailnet-oauth-file.ts';
import { buildHostRunArgs } from './build-host-run-args.ts';
import type { TailscaleArg } from './build-host-run-args.ts';
import { DEV_USAGE, parseDevCommand } from './parse-dev-command.ts';
import type { DevCommand } from './parse-dev-command.ts';
import { probeContainerRunning } from './probe-container-running.ts';
import { pruneDevImages } from './prune-dev-images.ts';
import { readLogTail } from './read-log-tail.ts';
import type { Dev, DevIO } from './types.ts';
import { waitDevReady } from './wait-dev-ready.ts';
import { wireDevIO } from './wire-dev-io.ts';

const UP_READY_S = 600;
const RESTART_READY_S = 60;
const STOP_POLL_MS = 200;

interface RunDevOptions {
  readonly argv: readonly string[];
  readonly env: DevEnv;
  readonly cwd: string;
  readonly io: DevIO;
}

// docs/guides/configuration.md#dev-instance lists the settings this reads.
export async function runDev(options: RunDevOptions): Promise<number> {
  const io = options.io;

  try {
    const env = options.env;
    const layout = buildDevLayout({ env, root: REPO_ROOT, cwd: options.cwd });
    const checkout = readDevCheckout(io.files.readRealPath, env, REPO_ROOT);
    const dev: Dev = { env, layout, checkout, io };
    const command = parseDevCommand(options.argv);

    if (command === null) {
      io.writeStderr(`${DEV_USAGE}\n`);

      return 2;
    }

    return await dispatchDev(dev, command);
  } catch (error) {
    if (error instanceof DevError) {
      io.writeStderr(`dev.sh: ${error.message}\n${error.detail}`);

      return 1;
    }

    // Each command that throws this streams its own output, so its stderr is already printed.
    if (error instanceof $.ShellError) {
      return error.exitCode;
    }

    throw error;
  }
}

function dispatchDev(dev: Dev, command: DevCommand): Promise<number> {
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
    .with('logs', () => dev.io.runAttached(['docker', 'logs', '-f', dev.layout.name]))
    .with('restart', async () => {
      await restartDev(dev);

      return 0;
    })
    .with('shell', () => dev.io.runAttached(['docker', 'exec', '-it', dev.layout.name, 'bash']))
    .with('token', () =>
      dev.io.runAttached(['docker', 'exec', dev.layout.name, 'cat', '/var/lib/imp/token']),
    )
    .with('prune', async () => {
      await pruneDevImages(dev);

      return 0;
    })
    .exhaustive();
}

async function upDev(dev: Dev): Promise<void> {
  const drives = await prepareDrives(dev);
  const isRunning = await probeContainerRunning(dev.io, dev.layout.name);

  if (isRunning) {
    dev.io.writeStdout(`dev.sh: ${dev.layout.name} already running`);
  } else {
    await startHost(dev, drives);

    dev.io.writeStdout(`dev.sh: started ${dev.layout.name}`);
  }

  await waitDevReady(dev, UP_READY_S);

  dev.io.writeStdout(
    `dev.sh: impd ready on ${dev.layout.apiURL} (token: scripts/dev/dev.sh token)`,
  );

  dev.io.writeStdout(
    `dev.sh: dashboard on ${dev.layout.apiURL}/ui/ (bun run build:dashboard to build it)`,
  );
}

interface Drives {
  readonly kernel: string;
  readonly systemDrive: string;
}

async function prepareDrives(dev: Dev): Promise<Drives> {
  const kernel = resolveKernel(dev);
  const systemSetting = dev.env['IMP_SYSTEM_DRIVE'] ?? '';
  const systemDrive = systemSetting || join(dev.checkout.buildDir, 'imp-system.squashfs');

  if (!dev.io.files.probeFile(kernel)) {
    throw new DevError(`no kernel at ${kernel}`);
  }

  await prepareHostImage(dev);

  // The docker cache makes this a no-op when the agent is unchanged.
  if (systemSetting === '') {
    const script = join(dev.checkout.root, 'scripts', 'release', 'build-system-drive.sh');

    await dev.io.shell`${script} > /dev/null`;
  }

  if (!dev.io.files.probeFile(systemDrive)) {
    throw new DevError(`no system drive at ${systemDrive}`);
  }

  return { kernel, systemDrive };
}

function resolveKernel(dev: Dev): string {
  const root = dev.checkout.root;
  const built = join(root, 'kernel', 'out', 'vmlinux');
  const setting = dev.env['IMP_KERNEL'] ?? '';

  if (setting !== '') {
    return setting;
  }

  return dev.io.files.probeFile(built) ? built : join(root, '.cache', 'vmlinux-ci');
}

// CI builds and loads the image first, with its own cache, and sets IMP_HOST_IMAGE_READY=1.
async function prepareHostImage(dev: Dev): Promise<void> {
  if (dev.env['IMP_HOST_IMAGE_READY'] !== '1') {
    await createHostImage(
      dev.io.shell,
      dev.checkout,
      readMachineID(dev.io.files.readText, dev.env).id,
    );

    return;
  }

  const inspect = await dev.io.shell`docker image inspect ${dev.checkout.hostImage}`
    .quiet()
    .nothrow();

  if (inspect.exitCode !== 0) {
    throw new DevError(`IMP_HOST_IMAGE_READY=1 but there is no ${dev.checkout.hostImage} image`);
  }
}

async function startHost(dev: Dev, drives: Drives): Promise<void> {
  const readOp = dev.io.makeOpReader(dev.env);

  await dev.io.shell`docker rm -f ${dev.layout.name}`.quiet().nothrow();

  dev.io.files.createDirectory(dev.layout.dataDir);

  const tailscale = await readHostTailscale(dev, readOp);
  const tailnetOAuthFile = await writeHostOAuthFile(dev, readOp);

  const acmeSetting = dev.env['IMP_ACME_CA_FILE'] ?? '';
  const acmeCAFile = acmeSetting === '' ? null : resolveContainerPath(dev, acmeSetting);
  const registryCASetting = dev.env['IMP_BUILD_TEST_REGISTRY_CA'] ?? '';

  const registryCAFile =
    registryCASetting === '' ? null : resolveContainerPath(dev, registryCASetting);

  const registryHost = await readRegistryHost(dev);

  const uplinkSetting = dev.env['IMP_UPLINK_MTU'] ?? '';
  const uplinkMTU = uplinkSetting === '' ? await readUplinkMTU(dev.io) : uplinkSetting;

  const args = buildHostRunArgs({
    layout: dev.layout,
    checkout: dev.checkout,
    env: tailscale.env,
    privileges: readHostPrivileges(dev.io.files, dev.checkout.root),
    hasEnvFile: dev.io.files.probeFile(join(dev.checkout.root, '.env')),
    tailscale: tailscale.arg,
    tailnetOAuthFile,
    acmeCAFile,
    registryCAFile,
    registryHost,
    kernel: resolveContainerPath(dev, drives.kernel),
    systemDrive: resolveContainerPath(dev, drives.systemDrive),
    uplinkMTU,
  });

  // docker reads .env and the key from its own environment, so no secret is in its argv.
  await dev.io.shell`docker ${args} > /dev/null`.env(toProcessEnv(tailscale.env));
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
    warn: (line) => {
      dev.io.writeStderr(`${line}\n`);
    },
    readText: dev.io.files.readText,
  });

  if (authkey === null) {
    return { arg: 'none', env: dev.env };
  }

  const tags = authkey.tags === null ? {} : { IMP_TAILSCALE_TAGS: authkey.tags };

  return { arg: 'key', env: { ...dev.env, TAILSCALE_AUTHKEY: authkey.key, ...tags } };
}

async function writeHostOAuthFile(dev: Dev, readOp: OpReader | null): Promise<string | null> {
  if (dev.env['IMP_TAILNET_NAMES'] !== '1') {
    return null;
  }

  const isWritten = await writeTailnetOAuthFile({
    file: join(dev.layout.dataDir, 'tailnet-oauth.json'),
    env: dev.env,
    readOp,
    warn: (line) => {
      dev.io.writeStderr(`${line}\n`);
    },
    writeSecretText: dev.io.files.writeSecretText,
  });

  if (!isWritten) {
    throw new DevError('IMP_TAILNET_NAMES=1 but 1Password has no OAuth client');
  }

  return '/data/tailnet-oauth.json';
}

// The checkout mounts at /src, so a path that a symlink leads out of it does not exist there.
function resolveContainerPath(dev: Dev, path: string): string {
  const root = dev.checkout.rootPhysical;
  const real = dev.io.files.readRealPath(path);

  if (!real.startsWith(`${root}/`)) {
    throw new DevError(`${path} is not under ${dev.checkout.root}`);
  }

  return `/src/${real.slice(root.length + 1)}`;
}

async function readRegistryHost(dev: Dev): Promise<string | null> {
  const registry = dev.env['IMP_BUILD_TEST_REGISTRY'] ?? '';

  if (registry === '') {
    return null;
  }

  const separator = registry.lastIndexOf(':');
  const name = separator === -1 ? registry : registry.slice(0, separator);

  const hosts = await dev.io.shell`getent ahostsv4 ${name}`.quiet().nothrow();

  const address = hosts.stdout.toString().split(/\s+/u)[0] ?? '';

  if (address === '') {
    throw new DevError(`${name} (IMP_BUILD_TEST_REGISTRY) does not resolve on this machine`);
  }

  return `${name}:${address}`;
}

// The container's own eth0 claims 1500 whatever the real path allows.
async function readUplinkMTU(io: DevIO): Promise<string> {
  const route = await io.shell`ip route show default`.quiet().nothrow();

  const device = route.stdout.toString().split(/\s+/u)[4] ?? '';

  return io.files.readText(`/sys/class/net/${device}/mtu`)?.trim() ?? '1500';
}

// SIGTERM gives impd time to sleep every imp, so memory survives.
async function downDev(dev: Dev): Promise<void> {
  const isRunning = await probeContainerRunning(dev.io, dev.layout.name);

  if (isRunning) {
    await dev.io.shell`docker stop -t 120 ${dev.layout.name} > /dev/null`;

    const tail = await readLogTail(dev.io, dev.layout.name, 5);

    for (const line of tail.split('\n').filter((entry) => entry.includes('every imp asleep'))) {
      dev.io.writeStdout(line);
    }
  }

  await dev.io.shell`docker rm -f ${dev.layout.name}`.quiet().nothrow();
}

// SIGHUP: impd exits without sleeping the VMs, and the entrypoint restarts it. The wait for the old
// pid to go makes /health answer from the new impd.
async function restartDev(dev: Dev): Promise<void> {
  const isRunning = await probeContainerRunning(dev.io, dev.layout.name);

  if (!isRunning) {
    throw new DevError(`${dev.layout.name} is not running; use scripts/dev/dev.sh up`);
  }

  const pattern = 'bun .*/daemon/src/main.ts';

  const found = await dev.io.shell`docker exec ${dev.layout.name} pgrep -f ${pattern}`
    .quiet()
    .nothrow();

  // pgrep exits 1 when nothing matches; any other failure means the lookup itself broke.
  if (found.exitCode !== 0 && found.exitCode !== 1) {
    throw new DevError(`cannot find impd's process in ${dev.layout.name}`, found.stderr.toString());
  }

  const pids = found.stdout
    .toString()
    .split('\n')
    .filter((pid) => pid !== '');

  if (pids.length > 0) {
    await dev.io.shell`docker exec ${dev.layout.name} kill -HUP ${pids}`;
    await waitForExit(dev, pids);
  }

  await waitDevReady(dev, RESTART_READY_S);
}

async function waitForExit(dev: Dev, pids: readonly string[]): Promise<void> {
  const stopSeconds = parseSecondsSetting(dev.env, 'IMP_DEV_STOP_TIMEOUT_S', 30);
  const deadline = dev.io.now() + stopSeconds * 1000;

  for (;;) {
    const alive = await dev.io.shell`docker exec ${dev.layout.name} kill -0 ${pids}`
      .quiet()
      .nothrow();

    if (alive.exitCode !== 0) {
      return;
    }

    if (dev.io.now() >= deadline) {
      throw new DevError(`impd ${pids.join(' ')} did not exit`);
    }

    await dev.io.sleep(STOP_POLL_MS);
  }
}

if (import.meta.main) {
  const exitCode = await runDev({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    io: wireDevIO(),
  });

  process.exit(exitCode);
}
