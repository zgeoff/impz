import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { parseStepCommand } from '../lib/parse-step-command.ts';
import { pickLogCollection } from './pick-log-collection.ts';

// Runs after a failure or a timeout too, with or without a container, so nothing it does may fail
// the job.
async function main(): Promise<void> {
  const command = parseStepCommand(
    'collect-e2e-logs.ts',
    [
      { name: 'engine', choices: ['docker', 'podman'] },
      { name: 'container' },
      { name: 'logs dir', isOptional: true },
    ],
    process.argv.slice(2),
  );

  if (!command.isValid) {
    console.error(command.usage);

    process.exitCode = 2;

    return;
  }

  const [engine, container, logsDir = join('.cache', 'e2e')] = command.values;

  invariant(
    (engine === 'docker' || engine === 'podman') && container !== undefined,
    'the parser asks for a container and an engine of docker or podman',
  );

  const zfsDir = process.env['IMP_ZFS_TEST_DIR'] ?? null;

  const plan = pickLogCollection({
    engine,
    container,
    owner: `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    logsDir,
    zfsDir,
    dataDir: process.env['IMP_DEV_DATA'] ?? null,
    zfsDirFiles: readZfsDirFiles(zfsDir),
  });

  for (const prepare of plan.prepareCommands) {
    await $`${prepare}`.nothrow();
  }

  runReported(`cannot create ${logsDir}`, () => {
    mkdirSync(logsDir, { recursive: true });
  });

  for (const copy of plan.copies) {
    runReported(`cannot copy ${copy.from}`, () => {
      copyFileSync(copy.from, copy.to);
    });
  }

  const logs = await $`${plan.logsCommand} 2>&1`.nothrow().quiet();

  const impdLog = join(logsDir, 'impd.log');

  runReported(`cannot write ${impdLog}`, () => {
    appendFileSync(impdLog, logs.stdout);
  });

  for (const disk of plan.diskCommands) {
    await $`${disk}`.nothrow();
  }
}

function readZfsDirFiles(zfsDir: string | null): string[] {
  if (zfsDir === null || !existsSync(zfsDir)) {
    return [];
  }

  try {
    return readdirSync(zfsDir);
  } catch (error) {
    console.error(`cannot list ${zfsDir}: ${String(error)}`);

    return [];
  }
}

function runReported(failure: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(`${failure}: ${String(error)}`);
  }
}

if (import.meta.main) {
  await main();
}
