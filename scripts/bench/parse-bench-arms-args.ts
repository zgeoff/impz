import { parseArgs } from 'node:util';
import { parseBenchArgs } from '@impz/cli/parse-bench-args';

export interface BenchArm {
  readonly name: string;
  readonly checkout: string;
}

export interface BenchArmsArgs {
  readonly arms: readonly BenchArm[];
  readonly rounds: number;
  readonly out: string;
  readonly benchArgs: readonly string[];
  readonly warmUpArgs: readonly string[];
}

export const BENCH_ARMS_USAGE =
  'usage: bun scripts/bench/run-bench-arms.ts --out <dir> [--rounds <n>] --arm <name>=<checkout>... [-- <impz bench args>]';

// A boot template serves one memory size, so the timed run's --memory reaches
// the warm-up's creates too, and the warm-up warms the template that run
// boots from.
export function parseBenchArmsArgs(argv: readonly string[]): BenchArmsArgs | string {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const forwarded = split === -1 ? [] : argv.slice(split + 1);
  const parsed = parseOwnArgs(own);

  if (parsed === null) {
    return BENCH_ARMS_USAGE;
  }

  const rounds = Number(parsed.rounds);
  const specs = parsed.arm ?? [];

  if (parsed.out === undefined || !Number.isInteger(rounds) || rounds < 1 || specs.length === 0) {
    return BENCH_ARMS_USAGE;
  }

  const arms: BenchArm[] = [];

  for (const spec of specs) {
    const groups = /^(?<name>[a-z][a-z0-9-]*)=(?<checkout>.+)$/u.exec(spec)?.groups;
    const name = groups?.['name'];
    const checkout = groups?.['checkout'];

    if (name === undefined || checkout === undefined) {
      return `bench arms: an arm is <name>=<checkout>, not ${spec}`;
    }

    arms.push({ name, checkout });
  }

  const bench = parseBenchArgs(forwarded);

  if (typeof bench === 'string') {
    return `bench arms: the impz bench options do not parse: ${bench}`;
  }

  const memory = bench.memory === undefined ? [] : ['--memory', bench.memory];

  return {
    arms,
    rounds,
    out: parsed.out,
    benchArgs: forwarded,
    warmUpArgs: ['bench', 'create', '--concurrency', '1', '--samples', '3', ...memory],
  };
}

function parseOwnArgs(own: readonly string[]) {
  try {
    return parseArgs({
      args: [...own],
      options: {
        arm: { type: 'string', multiple: true },
        rounds: { type: 'string', default: '1' },
        out: { type: 'string' },
      },
    }).values;
  } catch {
    return null;
  }
}
