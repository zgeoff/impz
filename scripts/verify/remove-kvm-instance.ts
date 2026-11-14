import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { buildKvmInstance } from './build-kvm-instance.ts';
import { RUN_DIRECTORY_ENV } from './constants.ts';

// `docker rm -f`, not `dev.sh down`: down waits for every imp to sleep, and the supervisor kills
// the app 5 s after its SIGTERM. The stop command and the app's SIGTERM both run this, so a second
// run must find nothing and change nothing.
export async function removeKvmInstance(runDirectory: string): Promise<void> {
  const instance = buildKvmInstance(runDirectory);

  const peak = await $`docker exec ${instance.name} cat /sys/fs/cgroup/memory.peak`
    .quiet()
    .nothrow();

  if (peak.exitCode === 0) {
    const peakMiB = Math.round(Number(peak.text().trim()) / 1024 ** 2);

    await writeFile(join(runDirectory, 'kvm-peak-memory.json'), JSON.stringify({ peakMiB }));
  }

  const proxy = `${instance.name}-docker-proxy`;

  await $`docker rm -f ${instance.name} ${proxy}`.quiet().nothrow();
  await $`docker volume rm ${`${instance.name}-docker`} ${proxy}`.quiet().nothrow();

  await rm(instance.dataDir, { recursive: true, force: true });
}

if (import.meta.main) {
  const runDirectory = process.env[RUN_DIRECTORY_ENV];

  invariant(runDirectory !== undefined, 'the launch plan sets the run folder');

  await removeKvmInstance(runDirectory);
}
