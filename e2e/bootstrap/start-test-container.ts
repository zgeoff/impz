import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { BootstrapTestError } from './bootstrap-test-error';
import { ARCHIVE_DIR } from './build-bootstrap-argv';
import { DISTROS } from './distros';
import type { Distro } from './distros';
import { readInContainer } from './read-in-container';
import type { BootstrapRun } from './types';

// policy-rc.d stops services from starting on install in a Docker image; a server has none. The
// masked units write kernel-global state (sysctls, modules, binfmt) or touch host devices, and the
// container shares the host's kernel.
const DISTRO_DOCKERFILE = `ARG BASE
FROM \${BASE}
ARG EXTRA
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      systemd systemd-sysv dbus openssh-server procps iproute2 ca-certificates \\
      netcat-openbsd e2fsprogs \${EXTRA} \\
 && rm -rf /var/lib/apt/lists/* \\
 && rm -f /usr/sbin/policy-rc.d
RUN systemctl mask systemd-sysctl.service systemd-modules-load.service \\
      systemd-udevd.service systemd-udevd-control.socket systemd-udevd-kernel.socket \\
      systemd-udev-trigger.service systemd-binfmt.service proc-sys-fs-binfmt_misc.automount \\
      systemd-timesyncd.service getty@tty1.service console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;

export async function startTestContainer(run: BootstrapRun, distro: Distro): Promise<void> {
  const io = run.io;
  const image = `imp-bootstrap-test:${distro}`;
  const base = DISTROS[distro];

  run.log(`[${distro}] building the systemd image`);

  await io.shell`docker build -q -t ${image} --build-arg ${`BASE=${base.base}`} --build-arg ${`EXTRA=${base.extra}`} - < ${new Response(DISTRO_DOCKERFILE)}`.quiet();

  const container = `imp-bootstrap-test-${distro}-${String(run.runID)}`;

  run.state.container = container;

  // Its own network namespace (the default bridge), never --network host: the firewall and the
  // inner Podman's rules never reach the host.
  const runArgs = [
    '--name',
    container,
    '--hostname',
    `imp-test-${distro}`,
    '--privileged',
    '--cgroupns=private',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',

    // Docker turns IPv6 off in a container on an IPv4-only network; the inner Podman's IPv6
    // network needs it on.
    '--sysctl',
    'net.ipv6.conf.all.disable_ipv6=0',
    '--sysctl',
    'net.ipv6.conf.default.disable_ipv6=0',

    // The inner Podman cannot put overlayfs on the container's own overlayfs, so its store is a
    // volume.
    '-v',
    '/var/lib/containers',
    '-v',
    `${run.work}:${ARCHIVE_DIR}:ro`,
  ];

  await io.shell`docker run -d ${runArgs} ${image}`.quiet();

  await waitForSystemd(run, distro);

  await io.shell`docker cp ${join(run.root, 'deploy', 'bootstrap.sh')} ${`${container}:/root/bootstrap.sh`}`.quiet();
}

const SYSTEMD_UP: ReadonlySet<string> = new Set(['running', 'degraded']);

// The bus is not up for the first moments, and "offline" comes before init runs.
async function waitForSystemd(run: BootstrapRun, distro: Distro): Promise<void> {
  let state = '';

  try {
    await waitFor(
      async () => {
        const answer = await readInContainer(run, ['systemctl', 'is-system-running', '--wait']);

        state = answer.output.trim();

        if (!SYSTEMD_UP.has(state)) {
          throw new Error(state);
        }
      },
      { intervalMs: 1000, timeoutMs: 60_000, now: run.io.now, wait: run.io.sleep },
    );
  } catch {
    throw new BootstrapTestError(`[${distro}] systemd did not come up: ${state}`);
  }
}
