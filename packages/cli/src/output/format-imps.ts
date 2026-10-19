import type { Imp } from '@impz/api';
import { formatTable } from './format-output';
import { IMP_HEADER } from './imp-header';
import { toImpRow } from './to-imp-row';

export function formatImps(imps: readonly Imp[]): string {
  return formatTable(
    IMP_HEADER,
    imps.map((imp) => toImpRow(imp)),
  );
}
