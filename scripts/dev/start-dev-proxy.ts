import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import type { DevEnv } from '../lib/build-dev-layout.ts';
import { DevError } from '../lib/dev-error.ts';
import { readProxyPrivileges } from '../lib/read-proxy-privileges.ts';
import { probeContainerRunning } from './probe-container-running.ts';
import { readLogTail } from './read-log-tail.ts';
import type { Dev } from './types.ts';

// The proxy compiles from the repo with the image's own bun, as the release image compiles it. A
// running proxy whose stamp changed stays with 'keep', because a replacement would cut off a build
// or an export in flight; restart then replaces it.
export async function startDevProxy(dev: Dev, mode: 'keep' | 'replace'): Promise<void> {
  const fresh = join(dev.layout.dataDir, 'imp-docker-proxy.new');
  const stampFile = join(dev.layout.dataDir, 'imp-docker-proxy.stamp');

  mkdirSync(dev.layout.dataDir, { recursive: true });

  await compileProxy(dev);

  const stamp = await readProxyStamp(dev, fresh);
  const isRunning = await probeContainerRunning(dev.layout.proxy);

  if (isRunning && stamp === readStampFile(stampFile)) {
    rmSync(fresh, { force: true });

    return;
  }

  if (isRunning && mode === 'keep') {
    rmSync(fresh, { force: true });

    process.stderr.write(
      `dev.sh: ${dev.layout.proxy} changed; scripts/dev/dev.sh restart replaces it\n`,
    );

    return;
  }

  await replaceProxy(dev, fresh);

  writeFileSync(stampFile, `${stamp}\n`);
}

async function compileProxy(dev: Dev): Promise<void> {
  const user = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
  const source = `${dev.checkout.root}:/src:ro`;
  const out = `${dev.layout.dataDir}:/out`;

  await $`docker run --rm --network none --user ${user} -e HOME=/tmp -v ${source} -v ${out} -w /src ${dev.checkout.hostImage} bun build --compile packages/daemon/src/imps/docker-proxy/main.ts --outfile /out/imp-docker-proxy.new > /dev/null`;
}

// The stamp covers what a running proxy depends on: its binary, privileges, env and image.
async function readProxyStamp(dev: Dev, fresh: string): Promise<string> {
  const binaryHash = createHash('sha256').update(readFileSync(fresh)).digest('hex');

  const image = await $`docker image inspect -f ${'{{.Id}}'} ${dev.checkout.hostImage}`
    .quiet()
    .nothrow();

  const parts = [
    ...readProxyPrivileges(dev.checkout.root),
    ...readProxyContext(dev.env, dev.checkout.root),
    dev.checkout.hostImage,
    image.stdout.toString(),
  ];

  return createHash('sha256').update(binaryHash).update(parts.join('\n')).digest('hex');
}

const CONTEXT_VARIABLES = ['IMP_BUILD_CONTEXT_MAX_MIB', 'IMP_BUILD_ISOLATION', 'IMP_BUILD_IMAGE'];

// Under imp isolation the proxy pulls only IMP_BUILD_IMAGE. impd takes each setting from the env,
// else .env, so the proxy does too; only these keys come from .env, never its secrets.
function readProxyContext(env: DevEnv, root: string): string[] {
  const envFile = join(root, '.env');
  const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : [];

  return CONTEXT_VARIABLES.flatMap((variable) => {
    const fromFile = lines.findLast((line) => line.startsWith(`${variable}=`));
    const value = env[variable] || fromFile?.slice(variable.length + 1).replaceAll('\r', '') || '';

    return value === '' ? [] : ['-e', `${variable}=${value}`];
  });
}

function readStampFile(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// The socket's directory and the token are volumes of their own; the token outlives a replaced
// proxy, so the containers it made stay its own.
async function replaceProxy(dev: Dev, fresh: string): Promise<void> {
  const binary = join(dev.layout.dataDir, 'imp-docker-proxy');
  const proxy = dev.layout.proxy;

  renameSync(fresh, binary);

  await $`docker rm -f ${proxy}`.quiet().nothrow();

  const groupOutput = await $`stat -c %g /var/run/docker.sock`.text();

  const group = groupOutput.trim();
  const privileges = readProxyPrivileges(dev.checkout.root);
  const context = readProxyContext(dev.env, dev.checkout.root);
  const image = `IMP_HOST_IMAGE=${dev.checkout.hostImage}`;
  const socketVolume = `${dev.layout.name}-docker:/run/imp-docker`;
  const tokenVolume = `${dev.layout.name}-docker-proxy:/var/lib/imp-docker-proxy`;
  const binaryMount = `${binary}:/usr/local/bin/imp-docker-proxy:ro`;

  await $`docker run -d --name ${proxy} ${privileges} --group-add ${group} -e ${image} ${context} -v /var/run/docker.sock:/var/run/docker.sock -v ${socketVolume} -v ${tokenVolume} -v ${binaryMount} ${dev.checkout.hostImage} /usr/local/bin/imp-docker-proxy > /dev/null`;
  await waitForSocket(proxy);
}

const SOCKET_TIMEOUT_MS = 30_000;
const SOCKET_POLL_MS = 200;

async function waitForSocket(proxy: string): Promise<void> {
  const deadline = Date.now() + SOCKET_TIMEOUT_MS;

  for (;;) {
    const probe = await $`docker exec ${proxy} test -S /run/imp-docker/docker.sock`
      .quiet()
      .nothrow();

    if (probe.exitCode === 0) {
      return;
    }

    const isRunning = await probeContainerRunning(proxy);

    if (!isRunning || Date.now() >= deadline) {
      const tail = await readLogTail(proxy, 20);

      throw new DevError(`${proxy} has no socket; last log lines:`, tail);
    }

    await Bun.sleep(SOCKET_POLL_MS);
  }
}
