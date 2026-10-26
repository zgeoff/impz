import { BootstrapTestError } from './bootstrap-test-error';
import { readInContainer } from './read-in-container';
import { runBootstrap } from './run-bootstrap';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';

const UNIT = '/etc/systemd/system/imp-host.service';
const UNIT_COPY = '/root/imp-host.service.podman';
const WRITTEN_FILES = ['/etc/imp/imp-host.env', UNIT];

export async function checkDockerHost(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] a host whose unit runs imp-host under Docker is refused before any change`);

  await runInContainer(run, ['cp', '-p', UNIT, UNIT_COPY]);

  await runInContainer(run, [
    'sed',
    '-i',
    's|^ExecStart=/usr/bin/podman run|ExecStart=/usr/bin/docker run|',
    UNIT,
  ]);

  const before = await runInContainer(run, ['sha256sum', ...WRITTEN_FILES]);
  const refusal = await runBootstrap(run, target, { mode: '--yes' });
  const after = await readInContainer(run, ['sha256sum', ...WRITTEN_FILES]);

  await runInContainer(run, ['mv', UNIT_COPY, UNIT]);

  if (refusal.exitCode !== 1) {
    throw new BootstrapTestError(
      `[${distro}] bootstrap.sh on a Docker host exited ${String(refusal.exitCode)}, not 1`,
    );
  }

  if (!refusal.output.includes('imp-host runs under Docker, from an older release')) {
    throw new BootstrapTestError(`[${distro}] the Docker host's refusal does not name Docker`);
  }

  if (after.output !== before) {
    throw new BootstrapTestError(`[${distro}] the Docker host run changed the env file or a unit`);
  }
}
