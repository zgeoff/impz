import type { ChangedPagesReport } from './changed-pages-report-schema';
import type { ChangedPages } from './count-changed-pages';

const PAGE_MIB = 4096 / 1_048_576;
const HUGE_PAGE_MIB = 2;

export function buildChangedPagesReport(changed: Readonly<ChangedPages>): ChangedPagesReport {
  return {
    changedMib: changed.pages * PAGE_MIB,
    changedHugeMib: changed.hugePages * HUGE_PAGE_MIB,
  };
}
