// A fallback still creates the imp, so no suite sees one on its own: a ZFS
// host restored no template while every suite passed.
const FALLBACK = / imp=\S+ boot template [0-9a-f]+ failed, booting the kernel/u;

// Docker drops a container's log when a suite recreates the container, so
// lines logged before that go unchecked.
export function collectBootFallbacks(log: string): string[] {
  return log.split('\n').filter((line) => FALLBACK.test(line));
}
