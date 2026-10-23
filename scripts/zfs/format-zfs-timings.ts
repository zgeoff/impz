const TIMINGS = [
  { label: 'checkpoint', pattern: /checkpoint cp-[a-z0-9]+ in [0-9]+ms/gu },
  { label: 'restore', pattern: /restored cp-[a-z0-9]+ in [0-9]+ms/gu },
  { label: 'disk clone (new/fork)', pattern: /disk cloned in [0-9]+ms/gu },
  { label: 'sleep', pattern: /: asleep in [0-9]+ms/gu },
] as const;

const MEM_FILE = /mem file [0-9]+ MiB on disk/gu;

const SUITE_METRIC =
  /^ +(?:newPlusExecMs|checkpointMs|restoreMs|forkCheckpointMs|forkLiveMs|idleToSleepMs|wakeOnHttpMs|backup[A-Za-z]+|bootTemplate[A-Za-z0-9]+): /u;

interface ZfsLogs {
  readonly impdLog: string;
  readonly e2eLog: string;
}

// The summary's text up to the pool's dataset list, which the caller reads from zfs.
export function formatZfsTimings(logs: ZfsLogs): string {
  const lines = [
    'zfs-host-test: impd timings on ZFS',
    ...TIMINGS.map((timing) =>
      formatTiming(timing.label, logs.impdLog.match(timing.pattern) ?? []),
    ),
    ...formatCounts((logs.impdLog.match(MEM_FILE) ?? []).toSorted()),
    '',
    "zfs-host-test: the suites' own metrics, CLI round trip included",
    ...logs.e2eLog.split('\n').filter((line) => SUITE_METRIC.test(line)),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function formatTiming(label: string, matches: readonly string[]): string {
  const values = matches
    .map((match) => Number(/(?<milliseconds>\d+)ms$/u.exec(match)?.groups?.['milliseconds']))
    .toSorted((left, right) => left - right);

  const padded = label.padEnd(22);
  const [first] = values;
  const last = values.at(-1);
  const median = values[Math.floor((values.length + 1) / 2) - 1];

  if (first === undefined || last === undefined || median === undefined) {
    return `${padded} no samples`;
  }

  return `${padded} n=${String(values.length)}  min ${String(first)}  median ${String(median)}  max ${String(last)} ms`;
}

// As uniq -c prints a sorted list: each run of equal lines once, after its count.
function formatCounts(sorted: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();

  for (const line of sorted) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  return [...counts].map((entry) => `${String(entry[1]).padStart(7)} ${entry[0]}`);
}
