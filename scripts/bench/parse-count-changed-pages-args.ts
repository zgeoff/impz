import { parseArgs, resolveArgs } from 'gunshi';
import type { Args } from 'gunshi';

export interface ChangedPagesPaths {
  readonly basePath: string;
  readonly nextPath: string;
}

const COUNT_CHANGED_PAGES_ARGS = {
  base: {
    type: 'positional',
    required: true,
    description: 'the memory file the guest started from',
  },
  snapshot: {
    type: 'positional',
    required: true,
    description: 'the memory file a later snapshot wrote',
  },
} as const satisfies Args;

export function parseCountChangedPagesArgs(argv: readonly string[]): ChangedPagesPaths | string {
  const resolved = resolveArgs(COUNT_CHANGED_PAGES_ARGS, parseArgs([...argv]));

  if (resolved.error !== undefined) {
    return resolved.error.errors
      .map((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
  }

  return { basePath: resolved.values.base, nextPath: resolved.values.snapshot };
}
