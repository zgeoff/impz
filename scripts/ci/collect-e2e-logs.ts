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
    engine !== undefined && container !== undefined,
    'the parser asks for an engine and a container',
  );

  const zfsDir = process.env['IMP_ZFS_TEST_DIR'] ?? null;

  const plan = pickLogCollection({
    engine,
    container,
    owner: `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    logsDir,
    zfsDir,
    dataDir: process.env['IMP_DEV_DATA'] ?? null,
    zfsDirFiles: zfsDir !== null && existsSync(zfsDir) ? readdirSync(zfsDir) : [],
  });

  for (const prepare of plan.prepareCommands) {
    await $`${prepare}`.nothrow();
  }

  mkdirSync(logsDir, { recursive: true });

  for (const copy of plan.copies) {
    try {
      copyFileSync(copy.from, copy.to);
    } catch (error) {
      console.error(`cannot copy ${copy.from}: ${String(error)}`);
    }
  }

  const logs = await $`${plan.logsCommand} 2>&1`.nothrow().quiet();

  appendFileSync(join(logsDir, 'impd.log'), logs.stdout);

  for (const disk of plan.diskCommands) {
    await $`${disk}`.nothrow();
  }
}

if (import.meta.main) {
  await main();
}
