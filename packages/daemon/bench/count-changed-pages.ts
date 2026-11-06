// The pages that differ from the base are what a dirty-page diff would write;
// it runs where both files are, in the dev container:
//   bun packages/daemon/bench/count-changed-pages.ts <base> <snapshot>
import { writeStderr } from '../../../scripts/lib/write-stderr.ts';
import { writeStdoutLine } from '../../../scripts/lib/write-stdout-line.ts';
import { buildChangedPagesReport } from '../src/test-utils/bench/build-changed-pages-report';
import { readChangedPages } from '../src/test-utils/bench/count-changed-pages';
import { parseCountChangedPagesArgs } from '../src/test-utils/bench/parse-count-changed-pages-args';
import { wireChangedPagesFS } from '../src/test-utils/bench/wire-changed-pages-fs';

const paths = parseCountChangedPagesArgs(process.argv.slice(2));

if (typeof paths === 'string') {
  writeStderr(`count-changed-pages: ${paths}\n`);

  process.exit(2);
}

const changed = readChangedPages(wireChangedPagesFS(), paths.basePath, paths.nextPath);

writeStdoutLine(JSON.stringify(buildChangedPagesReport(changed)));
