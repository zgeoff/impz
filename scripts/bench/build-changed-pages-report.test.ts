import { expect, test } from 'bun:test';
import { buildChangedPagesReport } from './build-changed-pages-report';
import { ChangedPagesReportSchema } from './changed-pages-report-schema';

test('it reports 4 KiB pages and 2 MiB pages in MiB', () => {
  expect(buildChangedPagesReport({ pages: 512, hugePages: 3 })).toStrictEqual({
    changedMib: 2,
    changedHugeMib: 6,
  });
});

test('it builds a report that its reader parses back whole', () => {
  const report = buildChangedPagesReport({ pages: 256, hugePages: 1 });
  const printed = JSON.stringify(report);

  expect(ChangedPagesReportSchema.parse(JSON.parse(printed))).toStrictEqual(report);
});
