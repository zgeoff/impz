// The pages that differ from the base are what a dirty-page diff would write;
// it runs where both files are, in the dev container:
//   bun scripts/bench/count-changed-pages.ts <base> <snapshot>
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { buildChangedPagesReport } from './build-changed-pages-report';

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

export function readChangedPages(basePath: string, nextPath: string): ChangedPages {
  const base = openSync(basePath, 'r');

  try {
    const next = openSync(nextPath, 'r');

    try {
      return countChangedChunks(base, next);
    } finally {
      closeSync(next);
    }
  } finally {
    closeSync(base);
  }
}

// each 2 MiB chunk is counted on its own, so a snapshot of many GiB never
// sits in memory whole
function countChangedChunks(base: number, next: number): ChangedPages {
  const length = Math.max(fstatSync(base).size, fstatSync(next).size);
  const total = { pages: 0, hugePages: 0 };

  for (let offset = 0; offset < length; offset += HUGE_PAGE_BYTES) {
    const baseChunk = new Uint8Array(HUGE_PAGE_BYTES);
    const nextChunk = new Uint8Array(HUGE_PAGE_BYTES);

    readSync(base, baseChunk, 0, HUGE_PAGE_BYTES, offset);
    readSync(next, nextChunk, 0, HUGE_PAGE_BYTES, offset);

    const counted = countChangedPages(baseChunk, nextChunk);

    total.pages += counted.pages;
    total.hugePages += counted.hugePages;
  }

  return total;
}

if (import.meta.main) {
  const parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true });
  const [basePath, nextPath] = parsed.positionals;

  if (basePath === undefined || nextPath === undefined || parsed.positionals.length > 2) {
    writeStderr('usage: bun scripts/bench/count-changed-pages.ts <base> <snapshot>\n');

    process.exit(2);
  }

  const changed = readChangedPages(basePath, nextPath);

  writeStdoutLine(JSON.stringify(buildChangedPagesReport(changed)));
}
