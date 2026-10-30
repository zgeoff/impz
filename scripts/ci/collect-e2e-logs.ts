import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { parseStepCommand } from '../lib/parse-step-command.ts';

const logsDir = join('.cache', 'e2e');

// Runs after a failure or a timeout too, with or without a container, so nothing it does may fail
// the job.
async function main(): Promise<void> {
  const command = parseStepCommand(
    'collect-e2e-logs.ts',
    [{ name: 'engine', choices: ['docker', 'podman'] }, { name: 'container' }],
    process.argv.slice(2),
  );

  if (!command.isValid) {
    console.error(command.usage);

    process.exitCode = 2;

    return;
  }

  const [engine, container] = command.values;

  invariant(container, 'the parser asks for a container');

  // the Podman proof runs as root and leaves root's files in the logs folder
  if (engine === 'podman') {
    const owner = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;

    await $`sudo mkdir -p ${logsDir}`.nothrow();
    await $`sudo chown -R ${owner} ${logsDir}`.nothrow();
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
