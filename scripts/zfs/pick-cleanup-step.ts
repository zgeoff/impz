import { match } from 'ts-pattern';
import type { VdevUse } from './read-vdev-use.ts';

interface CommandOutcome {
  readonly exitCode: number;
  readonly output: string;
}

// What cleanup has seen of the pool and its file; a step not yet taken leaves its field out.
export interface CleanupFacts {
  readonly prefix: string;
  readonly pool: string;
  readonly vdev: string;
  readonly status: number;
  readonly ownUse?: VdevUse;

  // stdout and stderr together.
  readonly destroyed?: CommandOutcome;

  // The key lines of each kernel oops in ZFS since the pool's create.
  readonly oops?: readonly string[];
  readonly anyUse?: VdevUse;

  // stderr alone.
  readonly removed?: CommandOutcome;
}

type CleanupStep =
  | { readonly action: 'read-own-use' }
  | { readonly action: 'destroy' }
  | { readonly action: 'read-oops' }
  | { readonly action: 'read-any-use' }
  | { readonly action: 'remove' }
  | { readonly action: 'finish'; readonly status: number; readonly stderr: readonly string[] };

export type CleanupAction = Exclude<CleanupStep['action'], 'finish'>;

// A pool that will not go keeps its file, so it can still be imported and destroyed by hand, and the
// run fails. An oops that kills its task inside ZFS, such as a Firecracker read() that trips the
// usercopy check, leaves a dataset hold that only a reboot releases, so it fails no run.
export function pickCleanupStep(facts: Readonly<CleanupFacts>): CleanupStep {
  const failed = facts.status === 0 ? 1 : facts.status;

  if (facts.ownUse === undefined) {
    return { action: 'read-own-use' };
  }

  if (facts.ownUse === 'used' && facts.destroyed === undefined) {
    return { action: 'destroy' };
  }

  if (facts.destroyed !== undefined && facts.destroyed.exitCode !== 0) {
    return pickAfterFailedDestroy(facts, facts.destroyed.output, failed);
  }

  if (facts.anyUse === undefined) {
    return { action: 'read-any-use' };
  }

  // Never the file of a pool that is still there, or may be.
  const kept = match(facts.anyUse)
    .with('unused', () => null)
    .with('used', () => `a pool still uses ${facts.vdev}; it stays`)
    .with('unknown', () => `zpool cannot say which pools use ${facts.vdev}; it stays`)
    .exhaustive();

  if (kept !== null) {
    return { action: 'finish', status: failed, stderr: [`${facts.prefix}: ${kept}\n`] };
  }

  if (facts.removed === undefined) {
    return { action: 'remove' };
  }

  if (facts.removed.exitCode !== 0) {
    return {
      action: 'finish',
      status: failed,
      stderr: [facts.removed.output, `${facts.prefix}: could not remove ${facts.vdev}\n`],
    };
  }

  return { action: 'finish', status: facts.status, stderr: [] };
}

function pickAfterFailedDestroy(
  facts: Readonly<CleanupFacts>,
  rawOutput: string,
  failed: number,
): CleanupStep {
  const output = rawOutput.replace(/\n+$/u, '');

  if (output.includes('pool is busy') && facts.oops === undefined) {
    return { action: 'read-oops' };
  }

  const echoed = output === '' ? [] : [`${output}\n`];
  const oops = facts.oops ?? [];

  if (oops.length > 0) {
    return {
      action: 'finish',
      status: facts.status,
      stderr: [
        ...echoed,
        `${facts.prefix}: a kernel oops in ZFS holds ${facts.pool} until a reboot; its file stays at ${facts.vdev}\n${oops.join('\n')}\n`,
      ],
    };
  }

  return {
    action: 'finish',
    status: failed,
    stderr: [
      ...echoed,
      `${facts.prefix}: could not destroy ${facts.pool}; its file stays at ${facts.vdev}\n`,
    ],
  };
}
