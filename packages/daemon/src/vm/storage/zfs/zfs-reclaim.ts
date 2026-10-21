import type { ZfsEntry } from './zfs-commands';

interface ReclaimRoots {
  readonly retired: string;
  readonly staging: string;
}

export type ReclaimStep =
  | { readonly kind: 'destroy'; readonly name: string }
  | { readonly kind: 'promote'; readonly name: string };

export function planReclaimStep(
  entries: readonly ZfsEntry[],
  roots: ReclaimRoots,
): ReclaimStep | null {
  const filesystems = entries.filter((entry) => entry.type === 'filesystem');

  const findClones = (snapshot: string) =>
    filesystems.filter((filesystem) => filesystem.origin === snapshot);

  for (const retired of filesystems) {
    if (!retired.name.startsWith(`${roots.retired}/`)) {
      continue;
    }

    const snapshots = entries.filter(
      (entry) => entry.type === 'snapshot' && entry.name.startsWith(`${retired.name}@`),
    );

    if (snapshots.some((snapshot) => !snapshot.deferDestroy)) {
      continue;
    }

    // ZFS destroys a marked snapshot with its last clone, so a marked one without clones is a
    // leftover that a crash cut short.
    const unused = snapshots.find((snapshot) => findClones(snapshot.name).length === 0);

    if (unused !== undefined) {
      return { kind: 'destroy', name: unused.name };
    }

    const newest = snapshots.at(-1);

    if (newest === undefined) {
      return { kind: 'destroy', name: retired.name };
    }

    const clone = findClones(newest.name).find(
      (filesystem) => !filesystem.name.startsWith(`${roots.staging}/`),
    );

    if (clone !== undefined) {
      return { kind: 'promote', name: clone.name };
    }
  }

  return null;
}
