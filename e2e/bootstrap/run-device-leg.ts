import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { expectBootstrapExit } from './expect-bootstrap-exit';
import { expectInContainer } from './expect-in-container';
import { removeTestContainer } from './remove-test-container';
import { runInContainer } from './run-in-container';
import { startTestContainer } from './start-test-container';
import { STORAGE_PATHS } from './storage-paths';
import type { BootstrapRun, BootstrapTarget } from './types';

// --data-device on loop devices: the refusals first (a device with ext4, a mounted device), then
// --check with --storage zfs, then a real XFS run and --check. The health check is skipped; the
// loop-file legs cover it.
export async function runDeviceLeg(run: BootstrapRun): Promise<void> {
  const distro = 'debian';
  const disks = STORAGE_PATHS;

  await startTestContainer(run, distro);

  const empty = await runInContainer(run, [
    'bash',
    '-c',
    `truncate -s 20G ${disks.diskEmpty} && losetup -f --show ${disks.diskEmpty}`,
  ]);

  const ext4 = await runInContainer(run, [
    'bash',
    '-c',
    `truncate -s 1G ${disks.diskExt4} && mkfs.ext4 -q ${disks.diskExt4} && losetup -f --show ${disks.diskExt4}`,
  ]);

  const onDevice = (storage: readonly string[]): BootstrapTarget => ({
    distro,
    storage,
    health: false,
  });

  run.log(`[${distro}] --data-device refuses a device with ext4`);

  const holdsExt4 = await expectBootstrapExit(run, onDevice(['--data-device', ext4]), {
    want: 1,
    mode: '--check',
  });

  if (!holdsExt4.includes('holds ext4')) {
    throw new BootstrapTestError(`[${distro}] no 'holds ext4' refusal`);
  }

  run.log(`[${distro}] --data-device refuses a mounted device`);

  await runInContainer(run, ['bash', '-c', `mkdir -p /mnt/ext4 && mount ${ext4} /mnt/ext4`]);

  const mounted = await expectBootstrapExit(run, onDevice(['--data-device', ext4]), {
    want: 1,
    mode: '--check',
  });

  if (!mounted.includes('is mounted')) {
    throw new BootstrapTestError(`[${distro}] no 'is mounted' refusal`);
  }

  run.log(`[${distro}] --check sizes a loop file from the free space`);

  const sized = await expectBootstrapExit(run, onDevice(['--loop-file', '/var/auto.xfs']), {
    want: 2,
    mode: '--check',
  });

  if (!/GiB free on \/; the loop file gets [0-9]+ GiB/u.test(sized)) {
    throw new BootstrapTestError(`[${distro}] --check did not size the loop file`);
  }

  await checkZfsPlan(run, onDevice(['--storage', 'zfs', '--data-device', empty]), empty);

  run.log(`[${distro}] --data-device on an empty device`);

  const xfs = onDevice(['--data-device', empty]);

  const applied = await applyBootstrap(run, xfs, { failure: 'the --data-device run failed' });

  if (!applied.includes('ipv6: off (auto: the host has no global IPv6 default route)')) {
    throw new BootstrapTestError(
      `[${distro}] auto did not turn IPv6 off on a host without an IPv6 route`,
    );
  }

  await expectInContainer(run, {
    argv: [
      'grep',
      '-qE',
      '^UUID=[0-9a-f-]+ /var/lib/imp xfs defaults,nosuid,nofail 0 2$',
      '/etc/fstab',
    ],
    failure: `[${distro}] /etc/fstab has no UUID entry for /var/lib/imp`,
  });

  await expectBootstrapExit(run, xfs, { want: 0, mode: '--check' });

  run.log(`[${distro}] --storage zfs refuses an XFS host whose mount is down`);

  await runInContainer(run, ['umount', '/var/lib/imp']);

  const fstab = await expectBootstrapExit(
    run,
    onDevice(['--storage', 'zfs', '--data-device', ext4]),
    { want: 1, mode: '--check' },
  );

  if (!fstab.includes('/etc/fstab has an entry for /var/lib/imp')) {
    throw new BootstrapTestError(`[${distro}] no fstab refusal`);
  }

  await removeTestContainer(run);

  run.log(`[${distro}] --data-device passed`);
}

async function checkZfsPlan(
  run: BootstrapRun,
  target: BootstrapTarget,
  device: string,
): Promise<void> {
  run.log(`[${target.distro}] --storage zfs --check on an empty device`);

  const plan = await expectBootstrapExit(run, target, { want: 2, mode: '--check' });

  const wanted = [
    'would: apt-get install linux-headers-',
    `would: zpool create tank on ${device}`,
    'would: zfs create tank/imp (mountpoint=legacy)',
    'would: write /etc/modprobe.d/imp-zfs.conf',
  ];

  for (const want of wanted) {
    if (!plan.includes(want)) {
      throw new BootstrapTestError(`[${target.distro}] --check with zfs did not plan: ${want}`);
    }
  }
}
