import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

const logsDir = join('.cache', 'e2e');

// Runs after a failure or a timeout too, with or without a container, so nothing it does may fail
// the job.
async function main(): Promise<void> {
  const [engine, container] = process.argv.slice(2);

  if ((engine !== 'docker' && engine !== 'podman') || container === undefined) {
    console.error('usage: collect-e2e-logs.ts <docker|podman> <container>');

    process.exitCode = 2;

    return;
  }

  mkdirSync(logsDir, { recursive: true });

  // the zfs host test keeps its logs and summary in its work dir
  const zfsDir = process.env['IMP_ZFS_TEST_DIR'];

  for (const name of ['impd.log', 'e2e.log', 'summary.txt']) {
    if (zfsDir !== undefined && existsSync(join(zfsDir, name))) {
      copyFileSync(join(zfsDir, name), join(logsDir, name));
    }
  }

  // rootful Podman's containers are root's to read
  const logs =
    engine === 'podman'
      ? await $`sudo podman logs ${container} 2>&1`.nothrow().quiet()
      : await $`docker logs ${container} 2>&1`.nothrow().quiet();

  appendFileSync(join(logsDir, 'impd.log'), logs.stdout);

  const dataDir = process.env['IMP_DEV_DATA'];

  if (dataDir !== undefined) {
    await $`du -h ${join(dataDir, 'imp.xfs')}`.nothrow();
  }

  await $`df -h / /mnt`.nothrow();
}

if (import.meta.main) {
  await main();
}
