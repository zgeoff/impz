import { readInfo } from './imp-cli';
import { readGuestFile, writeGuestFile } from './imps';
import { runInContainer } from './instance';

// ZFS keeps a snapshot that a fork still needs, marked for deferred destroy,
// until the fork goes.
export function hasLiveSnapshot(listing: string, checkpointId: string): boolean {
  return listing.split('\n').some((line) => {
    const [name = '', deferDestroy = ''] = line.split('\t');

    return name.endsWith(`@${checkpointId}`) && deferDestroy === 'off';
  });
}

async function checkInContainer(...argv: readonly string[]): Promise<boolean> {
  const result = await runInContainer(argv);

  return result.exitCode === 0;
}

export function hasImpDir(impId: string): Promise<boolean> {
  return checkInContainer('test', '-e', `/var/lib/imp/imps/${impId}`);
}

export async function probeCheckpointStorage(
  impId: string,
  checkpointId: string,
): Promise<boolean> {
  const info = await readInfo();

  if (info.storage.backend === 'xfs') {
    return checkInContainer('test', '-e', `/var/lib/imp/imps/${impId}/checkpoints/${checkpointId}`);
  }

  const listed = await runInContainer([
    'zfs',
    'list',
    '-H',
    '-t',
    'snapshot',
    '-o',
    'name,defer_destroy',
  ]);

  if (listed.exitCode !== 0) {
    throw new Error(`zfs list exited ${String(listed.exitCode)}: ${listed.stderr.trim()}`);
  }

  return hasLiveSnapshot(listed.stdout, checkpointId);
}

export interface CrossWrites {
  readonly seenInA: string;
  readonly seenInB: string;

  readonly ownInB: string;
}

export async function writeCrossFiles(
  left: string,
  right: string,
  tag: string,
): Promise<CrossWrites> {
  await writeGuestFile(left, `/root/only-${tag}-a`, 'a');
  await writeGuestFile(right, `/root/only-${tag}-b`, 'b');

  const seenInA = await readGuestFile(left, `/root/only-${tag}-b`);
  const seenInB = await readGuestFile(right, `/root/only-${tag}-a`);
  const ownInB = await readGuestFile(right, `/root/only-${tag}-b`);

  return { seenInA, seenInB, ownInB };
}
