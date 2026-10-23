// A vdev line of `zpool status -P` is the path, two or more blanks, then the state and the counts.
// A path may hold spaces or a state word, so the path matches only when the state column follows
// it.
const STATE_COLUMN =
  /^[ \t]{2,}(?:ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|SPLIT|AVAIL|INUSE)(?:[ \t]|$)/u;

export function hasVdevLine(status: string, vdev: string): boolean {
  return status.split('\n').some((line) => {
    const trimmed = line.replace(/^[ \t]+/u, '');

    return trimmed.startsWith(vdev) && STATE_COLUMN.test(trimmed.slice(vdev.length));
  });
}
