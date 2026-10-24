import { BootstrapTestError } from './bootstrap-test-error';
import { ARCHIVE_DIR } from './build-bootstrap-argv';
import { STALE_STUB_IMAGE } from './create-stub-images';
import { expectBootstrapExit } from './expect-bootstrap-exit';
import { readInContainer } from './read-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';

const WRITTEN_FILES = [
  '/etc/imp/imp-host.env',
  '/etc/systemd/system/imp-host.service',
  '/etc/systemd/system/imp-docker-proxy.service',
];

export async function checkStaleImage(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] a stale image is refused before anything is written`);

  await runInContainer(run, ['docker', 'load', '-q', '-i', `${ARCHIVE_DIR}/stale.tar`]);

  const before = await runInContainer(run, ['sha256sum', ...WRITTEN_FILES]);

  const refusal = await expectBootstrapExit(run, target, {
    want: 1,
    mode: '--yes',
    image: STALE_STUB_IMAGE,
  });

  if (!refusal.includes('pull the new image')) {
    throw new BootstrapTestError(`[${distro}] the stale image's refusal does not say to pull`);
  }

  const after = await readInContainer(run, ['sha256sum', ...WRITTEN_FILES]);

  if (after.output !== before) {
    throw new BootstrapTestError(`[${distro}] the stale image run changed the env file or a unit`);
  }

  await runInContainer(run, ['docker', 'rmi', STALE_STUB_IMAGE]);
}
