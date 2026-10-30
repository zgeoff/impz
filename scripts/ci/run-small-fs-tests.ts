import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';

// The small-filesystem lane runs on a 4 GiB XFS of its own, loop-mounted as impd's data dir is.
// The mount needs sudo, and the lane's tests skip without IMP_TEST_SMALL_FS.
async function main(): Promise<void> {
  const fs = join(getStepEnv(process.env, 'RUNNER_TEMP'), 'small-fs');
  const image = `${fs}.img`;
  const owner = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;

  if (Bun.which('mkfs.xfs') === null) {
    await $`sudo apt-get update`;
    await $`sudo apt-get install -y --no-install-recommends xfsprogs`;
  }

  await $`truncate -s 4G ${image}`;
  await $`mkfs.xfs -q ${image}`;

  mkdirSync(fs);

  await $`sudo mount -o loop ${image} ${fs}`;

  try {
    await $`sudo chown ${owner} ${fs}`;

    const result = await $`bun run test:small-fs`
      .env({ ...process.env, IMP_TEST_SMALL_FS: fs })
      .nothrow();

    process.exitCode = result.exitCode;
  } finally {
    await $`sudo umount ${fs}`;

    rmSync(image, { force: true });
    rmSync(fs, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
