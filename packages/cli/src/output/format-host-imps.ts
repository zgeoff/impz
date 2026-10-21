import type { Imp } from '@impz/api';
import { formatTable } from './format-output';
import { IMP_HEADER } from './imp-header';
import { toImpRow } from './to-imp-row';

export function formatHostImps(imps: readonly (Imp & { readonly host: string })[]): string {
  return formatTable(
    ['HOST', ...IMP_HEADER],
    imps.map((imp) => [imp.host, ...toImpRow(imp)]),
  );
}
