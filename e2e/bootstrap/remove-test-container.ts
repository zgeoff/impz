import { STORAGE_PATHS } from './storage-paths';
import type { BootstrapRun } from './types';

// The loop devices and a ZFS pool are kernel-global: removing the container would leave them
// attached, so the pool goes and the mounts come down inside it first.
const TEARDOWN_SCRIPT = `
  systemctl stop imp-host 2>/dev/null
  pool=$1
  shift
  ! zpool list "$pool" >/dev/null 2>&1 || zpool destroy -f "$pool"
  for dir in /var/lib/imp /mnt/ext4; do ! mountpoint -q "$dir" || umount "$dir"; done
  for file in "$@"; do
    [ -e "$file" ] || continue
    for dev in $(losetup --list -n -O NAME -j "$file"); do losetup -d "$dev"; done
  done
`;

export async function removeTestContainer(run: BootstrapRun): Promise<void> {
  const container = run.state.container;

  if (container === null) {
    return;
  }

  const files = [STORAGE_PATHS.loopFile, STORAGE_PATHS.diskEmpty, STORAGE_PATHS.diskExt4];

  const teardown = await run.io
    .shell`docker exec ${container} bash -c ${TEARDOWN_SCRIPT} teardown ${run.zfsPool} ${files}`
    .quiet()
    .nothrow();

  if (teardown.exitCode !== 0) {
    run.io.writeStderr(teardown.stderr.toString());

    run.io.writeStderr(
      `test-bootstrap: WARNING: teardown in ${container} failed; check losetup -l\n`,
    );
  }

  const removal = await run.io.shell`docker rm -f -v ${container}`.quiet().nothrow();

  if (removal.exitCode !== 0) {
    run.io.writeStderr(removal.stderr.toString());
  }

  run.state.container = null;
}
