import { expect, test } from 'bun:test';
import { buildMockExtent } from '../../../testing/vm/build-mock-extent';
import { countOwnerBytes } from './count-owner-bytes';
import { EXTENT_FLAGS } from './fiemap';

test('it counts what only one owner holds as exclusive and the rest as shared', () => {
  const totals = countOwnerBytes([
    {
      owner: 'image:base',
      extents: [buildMockExtent({ physical: 0, length: 104_857_600, flags: EXTENT_FLAGS.shared })],
    },

    {
      owner: 'imp:a',
      extents: [
        buildMockExtent({ physical: 0, length: 62_914_560, flags: EXTENT_FLAGS.shared }),
        buildMockExtent({ physical: 524_288_000, length: 10_485_760, flags: EXTENT_FLAGS.shared }),
      ],
    },
    {
      owner: 'imp:a',
      extents: [
        buildMockExtent({ physical: 524_288_000, length: 10_485_760, flags: EXTENT_FLAGS.shared }),
      ],
    },

    {
      owner: 'imp:b',
      extents: [
        buildMockExtent({ physical: 0, length: 104_857_600, flags: EXTENT_FLAGS.shared }),
        buildMockExtent({ physical: 734_003_200, length: 5_242_880 }),
      ],
    },
  ]);

  expect(Object.fromEntries(totals)).toStrictEqual({
    'image:base': { exclusiveBytes: 0, sharedBytes: 104_857_600 },
    'imp:a': { exclusiveBytes: 10_485_760, sharedBytes: 62_914_560 },
    'imp:b': { exclusiveBytes: 5_242_880, sharedBytes: 104_857_600 },
  });
});

test('it counts a shared extent that no other owner holds as exclusive', () => {
  const totals = countOwnerBytes([
    {
      owner: 'imp:a',
      extents: [buildMockExtent({ physical: 0, length: 8_388_608, flags: EXTENT_FLAGS.shared })],
    },
  ]);

  expect(totals.get('imp:a')).toStrictEqual({ exclusiveBytes: 8_388_608, sharedBytes: 0 });
});

test('it counts a delayed allocation as exclusive even when it is marked shared', () => {
  // FIEMAP reports a delayed allocation at physical 0, which a real shared extent can also hold
  const totals = countOwnerBytes([
    {
      owner: 'imp:a',
      extents: [
        buildMockExtent({
          physical: 0,
          length: 1_048_576,
          flags: EXTENT_FLAGS.shared | EXTENT_FLAGS.delalloc,
        }),
      ],
    },
    {
      owner: 'imp:b',
      extents: [buildMockExtent({ physical: 0, length: 1_048_576, flags: EXTENT_FLAGS.shared })],
    },
  ]);

  expect(Object.fromEntries(totals)).toStrictEqual({
    'imp:a': { exclusiveBytes: 1_048_576, sharedBytes: 0 },
    'imp:b': { exclusiveBytes: 1_048_576, sharedBytes: 0 },
  });
});
