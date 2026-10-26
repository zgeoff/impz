import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { ARCHIVE_DIR } from './build-bootstrap-argv';
import { MOVE_REGISTRY, MOVE_STUB_IMAGE } from './create-stub-images';
import type { Distro } from './distros';
import { expectInContainer } from './expect-in-container';
import { readInContainer } from './read-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';

const MARKER = '/var/lib/imp/docker-move-marker';

export async function checkDockerMove(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] upgrade.sh moves a Docker host to Podman, and imp-host keeps /var/lib/imp`);

  // With IPv6, the old unit made Docker's network with a line that the Podman unit has no form of.
  await applyBootstrap(run, target, {
    extra: ['--ipv6', 'off'],
    failure: 'the --ipv6 off run before the Docker host failed',
  });

  await runInContainer(run, [
    'bash',
    '-c',
    'apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends docker.io docker-cli',
  ]);

  await startRegistry(run, distro);
  await runInContainer(run, ['docker', 'load', '-q', '-i', `${ARCHIVE_DIR}/move.tar`]);
  await runInContainer(run, ['docker', 'push', MOVE_STUB_IMAGE]);

  await runInContainer(run, [
    'bash',
    '-c',
    `mkdir -p /etc/containers/registries.conf.d && printf '[[registry]]\\nlocation = "${MOVE_REGISTRY}"\\ninsecure = true\\n' > /etc/containers/registries.conf.d/50-imp-docker-move.conf`,
  ]);

  await startDockerHost(run, distro);

  const seeded = `seeded under Docker by run ${String(run.runID)}`;

  await runInContainer(run, [
    'docker',
    'exec',
    'imp-host',
    'sh',
    '-c',
    `printf %s "$1" > ${MARKER}`,
    'sh',
    seeded,
  ]);

  const container = run.state.container;

  invariant(container !== null, 'no test container is running');

  await run.io.shell`docker cp ${join(run.root, 'deploy')} ${`${container}:/root/deploy`}`.quiet();

  const upgrade = await readInContainer(run, ['bash', '-c', 'bash /root/deploy/upgrade.sh 2>&1']);

  for (const line of upgrade.output.split('\n')) {
    run.io.writeStdout(`  | ${line}`);
  }

  if (upgrade.exitCode !== 0) {
    throw new BootstrapTestError(
      `[${distro}] upgrade.sh on a Docker host exited ${String(upgrade.exitCode)}`,
    );
  }

  if (!upgrade.output.includes('upgrade: done, on Podman.')) {
    throw new BootstrapTestError(`[${distro}] upgrade.sh did not report the move to Podman`);
  }

  const marker = await readInContainer(run, ['podman', 'exec', 'imp-host', 'cat', MARKER]);

  if (marker.exitCode !== 0 || marker.output !== seeded) {
    throw new BootstrapTestError(
      `[${distro}] imp-host on Podman does not read the file that it wrote under Docker`,
    );
  }

  await expectInContainer(run, {
    argv: ['docker', 'container', 'inspect', 'imp-host'],
    failure: `[${distro}] Docker still has an imp-host container after the move`,
    fails: true,
  });
}

const REGISTRY_IMAGE = 'docker.io/library/registry:3';

async function startRegistry(run: BootstrapRun, distro: Distro): Promise<void> {
  await runInContainer(run, [
    'docker',
    'run',
    '-d',
    '--name',
    'imp-docker-move-registry',
    '--network',
    'host',

    // The runner's kernel has AppArmor, and the test container has no apparmor_parser to load
    // Docker's default profile.
    '--security-opt',
    'apparmor=unconfined',
    REGISTRY_IMAGE,
  ]);

  try {
    await waitFor(
      async () => {
        await runInContainer(run, ['curl', '-fsS', `http://${MOVE_REGISTRY}/v2/`]);
      },
      { intervalMs: 1000, timeoutMs: 30_000, now: run.io.now, wait: run.io.sleep },
    );
  } catch {
    throw new BootstrapTestError(`[${distro}] the registry for the Docker host move did not start`);
  }
}

const UNIT = '/etc/systemd/system/imp-host.service';
const ENV_FILE = '/etc/imp/imp-host.env';

// The unit from before the move to Podman ran the same arguments under Docker, with its proxy's
// socket besides, which the stub never reads.
async function startDockerHost(run: BootstrapRun, distro: Distro): Promise<void> {
  await runInContainer(run, ['systemctl', 'stop', 'imp-host']);
  await runInContainer(run, ['podman', 'rm', '-f', '--ignore', 'imp-host']);
  await runInContainer(run, ['sed', '-i', 's|/usr/bin/podman|/usr/bin/docker|g', UNIT]);

  await runInContainer(run, [
    'bash',
    '-c',
    `sed -i '/^IMP_HOST_IMAGE=/d' ${ENV_FILE} && echo IMP_HOST_IMAGE=${MOVE_STUB_IMAGE} >> ${ENV_FILE}`,
  ]);

  await runInContainer(run, ['systemctl', 'daemon-reload']);

  // As bootstrap.sh's unit reload does: the runs before this one restarted imp-host often enough
  // to near systemd's start-rate limit.
  await runInContainer(run, ['systemctl', 'reset-failed', 'imp-host']);

  const start = await readInContainer(run, ['systemctl', 'start', 'imp-host']);

  if (start.exitCode !== 0) {
    throw new BootstrapTestError(`[${distro}] imp-host did not start under Docker`);
  }

  try {
    await waitFor(
      async () => {
        const inspect = await readInContainer(run, [
          'docker',
          'container',
          'inspect',
          '-f',
          '{{.State.Running}}',
          'imp-host',
        ]);

        if (inspect.output !== 'true') {
          throw new Error('imp-host is not running under Docker');
        }
      },
      { intervalMs: 1000, timeoutMs: 30_000, now: run.io.now, wait: run.io.sleep },
    );
  } catch {
    const journal = await readInContainer(run, [
      'journalctl',
      '-u',
      'imp-host',
      '--no-pager',
      '-n',
      '20',
    ]);

    run.io.writeStderr(`${journal.output}\n`);
    throw new BootstrapTestError(`[${distro}] imp-host is not running under Docker`);
  }
}
