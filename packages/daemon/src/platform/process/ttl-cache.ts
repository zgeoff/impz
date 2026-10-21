import { LRUCache } from 'lru-cache';

interface TtlCacheOptions {
  readonly max: number;

  readonly ttlMs: number;

  readonly now: () => number;
}

export function createTtlCache<K extends NonNullable<unknown>, V extends NonNullable<unknown>>(
  options: Readonly<TtlCacheOptions>,
): LRUCache<K, V> {
  return new LRUCache<K, V>({
    max: options.max,
    ttl: options.ttlMs,

    // lru-cache reads a start time of 0 as no start, so an entry set at a stub
    // clock's 0 would never expire; only differences count, so 1 ms more keeps
    // every start above 0
    perf: { now: () => options.now() + 1 },

    // lru-cache otherwise reuses one reading of the clock for 1 ms of real
    // time, which a stub clock does not pass
    ttlResolution: 0,
  });
}
