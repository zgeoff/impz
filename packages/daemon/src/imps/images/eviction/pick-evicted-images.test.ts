import { expect, test } from 'bun:test';
import { buildMockImageUse } from '../../../../testing/imps/build-mock-image-use';
import { pickEvictedImages } from './pick-evicted-images';

test('it evicts nothing while usage is below the high mark', () => {
  const use = buildMockImageUse({ digest: 'sha256:old', lastUsedAt: 0 });

  const picked = pickEvictedImages(
    {
      uses: [use],
      keptNames: new Set(),
      spaces: new Map([['sha256:old', { freedBytes: 40, isShared: false }]]),
      usedBytes: 79,
      availableBytes: 21,
      now: 10_000_000,
    },
    { highPercent: 80, lowPercent: 60 },
  );

  expect(picked).toStrictEqual([]);
});

test('it evicts the least recently used images until usage would fall under the low mark', () => {
  const oldest = buildMockImageUse({ name: 'oldest', digest: 'sha256:a', lastUsedAt: 1000 });
  const older = buildMockImageUse({ name: 'older', digest: 'sha256:b', lastUsedAt: 2000 });
  const newer = buildMockImageUse({ name: 'newer', digest: 'sha256:c', lastUsedAt: 3000 });

  const picked = pickEvictedImages(
    {
      uses: [newer, oldest, older],
      keptNames: new Set(),
      spaces: new Map([
        ['sha256:a', { freedBytes: 20, isShared: false }],
        ['sha256:b', { freedBytes: 20, isShared: false }],
        ['sha256:c', { freedBytes: 20, isShared: false }],
      ]),
      usedBytes: 90,
      availableBytes: 10,
      now: 10_000_000,
    },
    { highPercent: 80, lowPercent: 60 },
  );

  expect(picked).toStrictEqual([oldest, older]);
});

test.each([
  ['an imp uses', { impCount: 1 }],
  ['is pinned', { isPinned: true }],
  ['is the default image', { name: 'ubuntu' }],
  ['was used within the last hour', { lastUsedAt: 9_000_000 }],
])('it never evicts an image that %s', (_label, overrides) => {
  const use = buildMockImageUse({ digest: 'sha256:old', lastUsedAt: 0, ...overrides });

  const picked = pickEvictedImages(
    {
      uses: [use],
      keptNames: new Set(['ubuntu']),
      spaces: new Map([['sha256:old', { freedBytes: 40, isShared: false }]]),
      usedBytes: 90,
      availableBytes: 10,
      now: 10_000_000,
    },
    { highPercent: 80, lowPercent: 60 },
  );

  expect(picked).toStrictEqual([]);
});

test('it never evicts an image whose blocks a clone shares, nor one with no measured space', () => {
  const shared = buildMockImageUse({ digest: 'sha256:shared', lastUsedAt: 0 });
  const unmeasured = buildMockImageUse({ digest: 'sha256:unmeasured', lastUsedAt: 0 });

  const picked = pickEvictedImages(
    {
      uses: [shared, unmeasured],
      keptNames: new Set(),
      spaces: new Map([['sha256:shared', { freedBytes: 40, isShared: true }]]),
      usedBytes: 90,
      availableBytes: 10,
      now: 10_000_000,
    },
    { highPercent: 80, lowPercent: 60 },
  );

  expect(picked).toStrictEqual([]);
});

test('it evicts every name of a digest together, and none while one of them is in use', () => {
  const first = buildMockImageUse({ name: 'first', digest: 'sha256:a', lastUsedAt: 0 });
  const second = buildMockImageUse({ name: 'second', digest: 'sha256:a', lastUsedAt: 0 });
  const idle = buildMockImageUse({ name: 'idle', digest: 'sha256:b', lastUsedAt: 0 });
  const busy = buildMockImageUse({ name: 'busy', digest: 'sha256:b', impCount: 1 });

  const picked = pickEvictedImages(
    {
      uses: [first, second, idle, busy],
      keptNames: new Set(),
      spaces: new Map([
        ['sha256:a', { freedBytes: 20, isShared: false }],
        ['sha256:b', { freedBytes: 20, isShared: false }],
      ]),
      usedBytes: 90,
      availableBytes: 10,
      now: 10_000_000,
    },
    { highPercent: 80, lowPercent: 60 },
  );

  expect(picked).toStrictEqual([first, second]);
});
