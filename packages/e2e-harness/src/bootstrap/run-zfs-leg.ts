import { join } from 'node:path';
import { readPoolProperties } from '../read-pool-properties';
import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { expectBootstrapExit } from './expect-bootstrap-exit';
import { expectInContainer } from './expect-in-container';
import { readInContainer } from './read-in-container';
import { removeTestContainer } from './remove-test-container';
import { runInContainer } from './run-in-container';
import { startTestContainer } from './start-test-container';
import { STORAGE_PATHS } from './storage-paths';
import type { BootstrapRun, BootstrapTarget } from './types';
import { waitForImpHost } from './wait-for-imp-host';

export async function runZfsLeg(run: BootstrapRun): Promise<void> {
  const distro = 'ubuntu24';
  const pool = run.zfsPool;
  const disk = STORAGE_PATHS.diskEmpty;

  await startTestContainer(run, distro);

  const device = await runInContainer(run, [
    'bash',
    '-c',
    `truncate -s 20G ${disk} && losetup -f --show ${disk}`,
  ]);

  const target: BootstrapTarget = {
    distro,
    storage: ['--storage', 'zfs', '--zfs-pool', pool, '--data-device', device],
    health: run.args.health,
  };

  run.log(`[${distro}] zfs: first run`);

  await applyBootstrap(run, target, { failure: 'the zfs run failed' });

  const mountpoint = await readInContainer(run, [
    'zfs',
    'get',
    '-H',
    '-o',
    'value',
    'mountpoint',
    `${pool}/imp`,
  ]);

  if (!mountpoint.output.split('\n').includes('legacy')) {
    throw new BootstrapTestError(`[${distro}] ${pool}/imp is not mountpoint=legacy`);
  }

  await checkPoolProperties(run, target);

  await expectInContainer(run, {
    argv: ['grep', '-qx', 'IMP_STORAGE_BACKEND=zfs', '/etc/imp/imp-host.env'],
    failure: `[${distro}] the env file is not zfs`,
  });

  await expectInContainer(run, {
    argv: ['grep', '-qx', `IMP_ZFS_ROOT=${pool}/imp`, '/etc/imp/imp-host.env'],
    failure: `[${distro}] no IMP_ZFS_ROOT`,
  });

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] the imp-host container is not running on zfs`);
  }

  run.log(`[${distro}] zfs: --check and a second run`);

  await expectBootstrapExit(run, target, { want: 0, mode: '--check' });

  const second = await applyBootstrap(run, target, { failure: 'the second zfs run failed' });

  if (!second.includes('bootstrap: 0 change(s) made')) {
    throw new BootstrapTestError(`[${distro}] the second zfs run changed something`);
  }

  await removeTestContainer(run);

  run.log(`[${distro}] zfs passed`);
}

async function checkPoolProperties(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const read = readPoolProperties(join(run.root, 'deploy', 'zfs-pool.json'), run.io.readText);

  if (read.kind === 'refused') {
    throw new BootstrapTestError(`[${target.distro}] ${read.reason}`);
  }

  for (const property of read.properties) {
    const value = await readInContainer(run, [
      property.tool,
      'get',
      '-H',
      '-o',
      'value',
      property.name,
      run.zfsPool,
    ]);

    if (!value.output.split('\n').includes(property.value)) {
      throw new BootstrapTestError(
        `[${target.distro}] ${run.zfsPool} does not have ${property.name}=${property.value}`,
      );
    }
  }
}
