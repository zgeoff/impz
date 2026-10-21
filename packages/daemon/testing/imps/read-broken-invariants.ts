import { listImps } from '../../src/platform/db/imps';
import type { ImpDatabase } from '../../src/platform/db/open-database';
import { probeSnapshot } from '../../src/vm/sleep/snapshot-meta';
import { buildImpPaths } from '../../src/vm/storage/data-layout';

interface InvariantParts {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly fake: {
    readonly alive: ReadonlySet<number>;
    readonly usedSnapshots: ReadonlySet<string>;
  };
}

// The records are read raw, because a service read repairs a dead VM or a lost snapshot
// and would hide the bug. Until `livenessRan`, a running record may still name a VM that died.
export async function readBrokenInvariants(
  ctx: Readonly<InvariantParts>,
  livenessRan: boolean,
): Promise<string[]> {
  const imps = await listImps(ctx.db);

  const broken: string[] = [];

  const owned = new Set<number>();

  for (const imp of imps) {
    const where = `${imp.name} (${imp.state})`;

    if (imp.state === 'creating') {
      broken.push(`${where}: still creating`);
    }

    // an error record keeps the pid of a VM that would not stop, to retry
    if (imp.state === 'error' && imp.pid !== null) {
      owned.add(imp.pid);
    } else if (imp.state !== 'running' && imp.pid !== null) {
      broken.push(`${where}: keeps pid ${String(imp.pid)}`);
    }

    const paths = buildImpPaths(ctx.dataDir, imp.id);

    if (imp.state === 'sleeping' && !probeSnapshot(paths)) {
      broken.push(`${where}: no snapshot to wake from`);
    }

    if (imp.state === 'sleeping' && ctx.fake.usedSnapshots.has(paths.snapshotDir)) {
      broken.push(`${where}: its snapshot was loaded once and no longer matches the disk`);
    }

    if (imp.state === 'running') {
      if (imp.pid === null) {
        broken.push(`${where}: no pid`);
      } else if (livenessRan && !ctx.fake.alive.has(imp.pid)) {
        broken.push(`${where}: its VM is dead`);
      } else if (owned.has(imp.pid)) {
        broken.push(`${where}: shares pid ${String(imp.pid)}`);
      } else {
        owned.add(imp.pid);
      }
    }
  }

  for (const pid of ctx.fake.alive) {
    if (!owned.has(pid)) {
      broken.push(`VM ${String(pid)} runs for no running imp`);
    }
  }

  return broken;
}
