import { mkdtempSync, rmdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildExitError, runCommand } from '../../src/platform/process/run-command';
import type { CommandRunner } from '../../src/platform/process/run-command';

export interface ZfsTestDatasetOptions {
  readonly parent: string;
  readonly parentDir: string;
  readonly run?: CommandRunner;
}

export interface ZfsTestDataset {
  readonly root: string;
  readonly dataDir: string;
}

export async function createZfsTestDataset(
  stack: Readonly<AsyncDisposableStack>,
  options: ZfsTestDatasetOptions,
): Promise<ZfsTestDataset> {
  const run = options.run ?? runCommand;
  const dataDir = mkdtempSync(join(options.parentDir, 'dataset-'));

  stack.defer(() => {
    rmdirSync(dataDir);
  });

  const root = `${options.parent}/${basename(dataDir)}`;

  const listed = await run(['zfs', 'list', '-H', '-o', 'name', root]);

  if (listed.exitCode === 0) {
    throw new Error(`zfs: ${root} exists already, and this run did not make it`);
  }

  await runOrThrow(run, ['zfs', 'create', '-o', 'mountpoint=legacy', root]);

  stack.defer(() => runOrThrow(run, ['zfs', 'destroy', '-R', root]));

  await runOrThrow(run, ['mount', '-t', 'zfs', root, dataDir]);

  stack.defer(() => runOrThrow(run, ['umount', '-R', dataDir]));

  return { root, dataDir };
}

async function runOrThrow(run: CommandRunner, argv: readonly string[]): Promise<void> {
  const result = await run(argv);

  if (result.exitCode !== 0) {
    throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
  }
}
