import { NameSchema } from '@impz/api';
import invariant from 'tiny-invariant';
import { UsageError } from '../cli/errors';
import { buildBenchImpName } from './build-bench-imp-name';

interface BenchNaming {
  readonly runID: string;
  readonly levels: readonly number[];
}

export function parseBenchPrefix(text: string, naming: Readonly<BenchNaming>): string {
  const namePrefix = `${text}${naming.runID}-`;
  const top = Math.max(...naming.levels);
  const longest = buildBenchImpName(namePrefix, top, top - 1);
  const parsed = NameSchema.safeParse(longest);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;

    invariant(issue);

    throw new UsageError(
      `--prefix ${text} gives imp names such as ${longest}, but an imp name ${issue.message}`,
    );
  }

  return namePrefix;
}
