const KIB_PER_MIB = 1024;

export const FIRECRACKER_MEMORY_SCRIPT = `
for pid in $(pgrep -x firecracker); do
  argv=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
  awk -v argv="$argv" '/^Pss:/ { p = $2 } /^Pss_Anon:/ { a = $2 } /^Pss_Shmem:/ { s = $2 }
    END { if (p != "") print p, (a == "" ? "-" : a), (s == "" ? "-" : s), argv }' \
    /proc/$pid/smaps_rollup 2>/dev/null
done`;

export function findImpIdFromArgv(argv: readonly string[]): string | null {
  const id = argv.indexOf('--id');

  if (id !== -1) {
    return argv[id + 1] ?? null;
  }

  const socket = argv[argv.indexOf('--api-sock') + 1] ?? '';

  return /\/imps\/(?<id>[^/]+)\/run\/api\.sock$/u.exec(socket)?.groups?.['id'] ?? null;
}

export interface FirecrackerMemory {
  readonly pssMib: number;

  // Anonymous and shmem pages, which the governor counts against the budget.
  readonly ownedMib: number;
  readonly count: number;

  readonly ownedByImpMib: ReadonlyMap<string, number>;
}

export function parseFirecrackerMemory(output: string): FirecrackerMemory {
  const ownedByImpMib = new Map<string, number>();

  let pssKib = 0;
  let ownedKib = 0;
  let count = 0;

  for (const line of output.split('\n')) {
    // A process gone between pgrep and its read prints nothing.
    if (line.trim() === '') {
      continue;
    }

    const words = line.trim().split(/\s+/u);
    const fields = words.slice(0, 3).map(Number);

    // Read as 0, a missing field would let a breach of the budget pass.
    if (fields.length !== 3 || fields.some((field) => !Number.isInteger(field))) {
      throw new Error(`smaps_rollup without Pss, Pss_Anon and Pss_Shmem: '${line}'`);
    }

    const [pss = 0, anon = 0, shmem = 0] = fields;

    pssKib += pss;
    ownedKib += anon + shmem;
    count += 1;

    const id = findImpIdFromArgv(words.slice(3));

    if (id !== null) {
      ownedByImpMib.set(id, Math.floor((anon + shmem) / KIB_PER_MIB));
    }
  }

  return {
    pssMib: Math.floor(pssKib / KIB_PER_MIB),
    ownedMib: Math.floor(ownedKib / KIB_PER_MIB),
    count,
    ownedByImpMib,
  };
}

// impd samples an imp's RAM every few seconds, so its figure for a new imp
// can be stale.
export function readSmallestOwnedMib(impIds: readonly string[], memory: FirecrackerMemory): number {
  const owned = impIds.map((id) => {
    const mib = memory.ownedByImpMib.get(id);

    if (mib === undefined) {
      throw new Error(`no Firecracker for imp ${id}`);
    }

    return mib;
  });

  return Math.min(...owned);
}
