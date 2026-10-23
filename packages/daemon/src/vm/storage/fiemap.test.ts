import { expect, mock, test } from 'bun:test';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { readOpenFileExtents } from './fiemap';
import type { ExtentBatchRead, ReadExtentBatch } from './fiemap';

test('it reads each batch from the end of the one before until an extent carries the last flag', () => {
  const answers = buildStubAnswerQueue<ExtentBatchRead>([
    {
      extents: [
        { logical: 0, physical: 4096, length: 8192, flags: 0 },
        { logical: 65_536, physical: 40_960, length: 4096, flags: 0x8_00 },
      ],
    },
    { extents: [{ logical: 131_072, physical: 81_920, length: 4096, flags: 0x1 }] },
  ]);

  const readExtentBatch = mock<ReadExtentBatch>(() => answers.next());
  const extents = readOpenFileExtents(7, readExtentBatch);

  expect(extents).toStrictEqual([
    { logical: 0, physical: 4096, length: 8192, flags: 0 },
    { logical: 65_536, physical: 40_960, length: 4096, flags: 0x8_00 },
    { logical: 131_072, physical: 81_920, length: 4096, flags: 0x1 },
  ]);

  expect(readExtentBatch.mock.calls).toStrictEqual([
    [7, 0],
    [7, 69_632],
  ]);
});

test('it reads a file with no extents as none', () => {
  expect(readOpenFileExtents(7, () => ({ extents: [] }))).toStrictEqual([]);
});

test('it gives null when a batch fails after one that succeeded', () => {
  const answers = buildStubAnswerQueue<ExtentBatchRead>([
    { extents: [{ logical: 0, physical: 4096, length: 8192, flags: 0 }] },
    { errno: 95 },
  ]);

  expect(readOpenFileExtents(7, () => answers.next())).toBeNull();
});
