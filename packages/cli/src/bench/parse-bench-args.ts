import { parseArgs, resolveArgs } from 'gunshi';
import type { ArgValues } from 'gunshi';
import { BENCH_ARGS } from './bench-args';

// a script that forwards options to `impz bench` reads them as the command
// does, so both sides of the forward share one definition
export function parseBenchArgs(argv: readonly string[]): ArgValues<typeof BENCH_ARGS> | string {
  const resolved = resolveArgs(BENCH_ARGS, parseArgs([...argv]));

  if (resolved.error !== undefined) {
    return resolved.error.errors
      .map((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
  }

  return resolved.values;
}
