// The pages that differ from the base are what a dirty-page diff would write;
// it runs where both files are, in the dev container:
//   bun scripts/bench/count-changed-pages.ts <base> <snapshot>
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { buildChangedPagesReport } from './build-changed-pages-report';
import { parseCountChangedPagesArgs } from './parse-count-changed-pages-args';
import { wireChangedPagesFS } from './wire-changed-pages-fs';

const PAGE_BYTES = 4096;
const HUGE_PAGE_BYTES = 2 * 1024 * 1024;

export interface ChangedPages {
  readonly pages: number;
  readonly hugePages: number;
}

export function countChangedPages(base: Uint8Array, next: Uint8Array): ChangedPages {
  const counted = { pages: 0, hugePages: 0 };
  const length = Math.max(base.length, next.length);

  for (let huge = 0; huge < length; huge += HUGE_PAGE_BYTES) {
    let isHugeChanged = false;

    for (let page = huge; page < Math.min(huge + HUGE_PAGE_BYTES, length); page += PAGE_BYTES) {
      if (!isPageEqual(base, next, page)) {
        counted.pages += 1;
        isHugeChanged = true;
      }
    }

    if (isHugeChanged) {
      counted.hugePages += 1;
    }
  }

  return counted;
}

// a page past the end of the shorter file reads as zeros, as a sparse file's hole does
function isPageEqual(base: Uint8Array, next: Uint8Array, start: number): boolean {
  return Buffer.from(toPage(base, start)).equals(toPage(next, start));
}

function toPage(bytes: Uint8Array, start: number): Uint8Array {
  const page = new Uint8Array(PAGE_BYTES);

  page.set(bytes.subarray(start, start + PAGE_BYTES));

  return page;
}

export interface ChangedPagesFS {
  readonly open: (path: string) => number;
  readonly readSize: (file: number) => number;
  readonly read: (file: number, chunk: Uint8Array, offset: number) => void;
  readonly close: (file: number) => void;
}

export function readChangedPages(
  fs: ChangedPagesFS,
  basePath: string,
  nextPath: string,
): ChangedPages {
  return withOpenFile(fs, basePath, (base) =>
    withOpenFile(fs, nextPath, (next) => countChangedChunks(fs, base, next)),
  );
}

// a close that fails after the read failed would hide why the read failed, so
// only a close after a read that worked can fail the count
function withOpenFile<T>(fs: ChangedPagesFS, path: string, use: (file: number) => T): T {
  const file = fs.open(path);
  let result: T;

  try {
    result = use(file);
  } catch (error) {
    try {
      fs.close(file);
    } catch {
      // the read error is the one to report
    }

    throw error;
  }

  fs.close(file);

  return result;
}

// each 2 MiB chunk is counted on its own, so a snapshot of many GiB never
// sits in memory whole
function countChangedChunks(fs: ChangedPagesFS, base: number, next: number): ChangedPages {
  const length = Math.max(fs.readSize(base), fs.readSize(next));
  const total = { pages: 0, hugePages: 0 };

  for (let offset = 0; offset < length; offset += HUGE_PAGE_BYTES) {
    const baseChunk = new Uint8Array(HUGE_PAGE_BYTES);
    const nextChunk = new Uint8Array(HUGE_PAGE_BYTES);

    fs.read(base, baseChunk, offset);
    fs.read(next, nextChunk, offset);

    const counted = countChangedPages(baseChunk, nextChunk);

    total.pages += counted.pages;
    total.hugePages += counted.hugePages;
  }

  return total;
}

if (import.meta.main) {
  const paths = parseCountChangedPagesArgs(process.argv.slice(2));

  if (typeof paths === 'string') {
    writeStderr(`count-changed-pages: ${paths}\n`);

    process.exit(2);
  }

  const changed = readChangedPages(wireChangedPagesFS(), paths.basePath, paths.nextPath);

  writeStdoutLine(JSON.stringify(buildChangedPagesReport(changed)));
}
