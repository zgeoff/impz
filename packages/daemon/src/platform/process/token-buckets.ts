export interface BucketSpec {
  readonly size: number;
  readonly refillMs: number;
}

interface Bucket {
  readonly tokens: number;
  readonly at: number;
}

// keys must be few, such as slots, public imps or known clients: the map keeps
// a bucket for every key it has seen
export function createTokenBuckets<Key>(
  readSpec: (key: Key) => BucketSpec,
  now: () => number,
): (key: Key) => boolean {
  const buckets = new Map<Key, Bucket>();

  return (key) => {
    const at = now();
    const spec = readSpec(key);
    const bucket = buckets.get(key) ?? { tokens: spec.size, at };
    const refilled = Math.min(spec.size, bucket.tokens + (at - bucket.at) / spec.refillMs);
    const isTaken = refilled >= 1;

    buckets.set(key, { tokens: isTaken ? refilled - 1 : refilled, at });

    return isTaken;
  };
}
