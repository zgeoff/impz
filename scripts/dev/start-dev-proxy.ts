import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DevEnv } from '../lib/build-dev-layout.ts';
import { DevError } from '../lib/dev-error.ts';
import { pickSetting } from '../lib/pick-setting.ts';
import { readProxyPrivileges } from '../lib/read-proxy-privileges.ts';
import { pickProxyAction } from './pick-proxy-action.ts';
import type { ProxyMode } from './pick-proxy-action.ts';
import { probeContainerRunning } from './probe-container-running.ts';
import { readLogTail } from './read-log-tail.ts';
import type { Dev, DevFiles } from './types.ts';

// The proxy compiles from the repo with the image's own bun, as the release image compiles it.
export async function startDevProxy(dev: Dev, mode: ProxyMode): Promise<void> {
  const fresh = join(dev.layout.dataDir, 'imp-docker-proxy.new');
  const stampFile = join(dev.layout.dataDir, 'imp-docker-proxy.stamp');

  dev.io.files.createDirectory(dev.layout.dataDir);

  await compileProxy(dev);

  const stamp = await readProxyStamp(dev, fresh);

  const action = pickProxyAction({
    isRunning: await probeContainerRunning(dev.io, dev.layout.proxy),
    stamp,
    storedStamp: dev.io.files.readText(stampFile)?.trim() ?? '',
    mode,
  });

  if (action !== 'replace') {
    dev.io.files.remove(fresh);
  }

  if (action === 'defer') {
    dev.io.writeStderr(
      `dev.sh: ${dev.layout.proxy} changed; scripts/dev/dev.sh restart replaces it\n`,
    );
  }

  if (action === 'replace') {
    await replaceProxy(dev, fresh);

    dev.io.files.writeText(stampFile, `${stamp}\n`);
  }
}

async function compileProxy(dev: Dev): Promise<void> {
  const source = `${dev.checkout.root}:/src:ro`;
  const out = `${dev.layout.dataDir}:/out`;

  await dev.io
    .shell`docker run --rm --network none --user ${dev.io.user} -e HOME=/tmp -v ${source} -v ${out} -w /src ${dev.checkout.hostImage} bun build --compile packages/daemon/src/imps/docker-proxy/main.ts --outfile /out/imp-docker-proxy.new > /dev/null`;
}

// The stamp covers what a running proxy depends on: its binary, privileges, env and image.
async function readProxyStamp(dev: Dev, fresh: string): Promise<string> {
  const binaryHash = createHash('sha256').update(dev.io.files.readBytes(fresh)).digest('hex');

  const image = await dev.io.shell`docker image inspect -f ${'{{.Id}}'} ${dev.checkout.hostImage}`
    .quiet()
    .nothrow();

  const parts = [
    ...readProxyPrivileges(dev.checkout.root),
    ...readProxyContext(dev.io.files, dev.env, dev.checkout.root),
    dev.checkout.hostImage,
    image.stdout.toString(),
  ];

  return createHash('sha256').update(binaryHash).update(parts.join('\n')).digest('hex');
}

const CONTEXT_VARIABLES = ['IMP_BUILD_CONTEXT_MAX_MIB', 'IMP_BUILD_ISOLATION', 'IMP_BUILD_IMAGE'];

// Under imp isolation the proxy pulls only IMP_BUILD_IMAGE. impd takes each setting from the env,
// else .env, so the proxy does too; only these keys come from .env, never its secrets.
function readProxyContext(files: DevFiles, env: DevEnv, root: string): string[] {
  const lines = files.readText(join(root, '.env'))?.split('\n') ?? [];

  return CONTEXT_VARIABLES.flatMap((variable) => {
    const fromFile = lines.findLast((line) => line.startsWith(`${variable}=`));

    const value =
      pickSetting(env, variable) ?? fromFile?.slice(variable.length + 1).replaceAll('\r', '') ?? '';

    return value === '' ? [] : ['-e', `${variable}=${value}`];
  });
}

// The socket's directory and the token are volumes of their own; the token outlives a replaced
// proxy, so the containers it made stay its own.
async function replaceProxy(dev: Dev, fresh: string): Promise<void> {
  const binary = join(dev.layout.dataDir, 'imp-docker-proxy');
  const proxy = dev.layout.proxy;

  dev.io.files.rename(fresh, binary);

  await dev.io.shell`docker rm -f ${proxy}`.quiet().nothrow();

  const group = await readSocketGroup(dev);

  const privileges = readProxyPrivileges(dev.checkout.root);
  const context = readProxyContext(dev.io.files, dev.env, dev.checkout.root);
  const image = `IMP_HOST_IMAGE=${dev.checkout.hostImage}`;
  const socketVolume = `${dev.layout.name}-docker:/run/imp-docker`;
  const tokenVolume = `${dev.layout.name}-docker-proxy:/var/lib/imp-docker-proxy`;
  const binaryMount = `${binary}:/usr/local/bin/imp-docker-proxy:ro`;

  await dev.io
    .shell`docker run -d --name ${proxy} ${privileges} --group-add ${group} -e ${image} ${context} -v /var/run/docker.sock:/var/run/docker.sock -v ${socketVolume} -v ${tokenVolume} -v ${binaryMount} ${dev.checkout.hostImage} /usr/local/bin/imp-docker-proxy > /dev/null`;

  await waitForSocket(dev, proxy);
}

async function readSocketGroup(dev: Dev): Promise<string> {
  const stat = await dev.io.shell`stat -c %g /var/run/docker.sock`.quiet().nothrow();

  if (stat.exitCode !== 0) {
    throw new DevError('cannot read the group of /var/run/docker.sock', stat.stderr.toString());
  }

  return stat.stdout.toString().trim();
}

const SOCKET_TIMEOUT_MS = 30_000;
const SOCKET_POLL_MS = 200;

async function waitForSocket(dev: Dev, proxy: string): Promise<void> {
  const deadline = dev.io.now() + SOCKET_TIMEOUT_MS;

  for (;;) {
    const probe = await dev.io.shell`docker exec ${proxy} test -S /run/imp-docker/docker.sock`
      .quiet()
      .nothrow();

    if (probe.exitCode === 0) {
      return;
    }

    const isRunning = await probeContainerRunning(dev.io, proxy);

    if (!isRunning || dev.io.now() >= deadline) {
      const tail = await readLogTail(dev.io, proxy, 20);

      throw new DevError(`${proxy} has no socket; last log lines:`, tail);
    }

    await dev.io.sleep(SOCKET_POLL_MS);
  }
}
