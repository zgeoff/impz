import { expect, test } from 'bun:test';
import { buildMockImageUse } from './build-mock-image-use';

test('it builds a default image use of an unpinned oci image no imp uses', () => {
  expect(buildMockImageUse()).toStrictEqual({
    id: expect.toSatisfy((id: string) => /^[0-9a-f\-]{36}$/v.test(id)),
    name: expect.toSatisfy((name: string) => /^[a-z0-9]{12}$/v.test(name)),
    digest: expect.toSatisfy((digest: string) => /^sha256:[0-9a-f]{64}$/v.test(digest)),
    source: 'oci',
    sizeBytes: expect.toBeWithin(1, 1024 ** 3 + 1),
    lastUsedAt: expect.toBeWithin(0, Date.now()),
    impCount: 0,
    isPinned: false,
  });
});

test('it applies overrides on top of the defaults', () => {
  const use = buildMockImageUse({
    id: 'image-1',
    name: 'web-0a1b2c3',
    digest: 'sha256:0000',
    source: 'imp',
    sizeBytes: 1024,
    lastUsedAt: 5,
    impCount: 2,
    isPinned: true,
  });

  expect(use).toStrictEqual({
    id: 'image-1',
    name: 'web-0a1b2c3',
    digest: 'sha256:0000',
    source: 'imp',
    sizeBytes: 1024,
    lastUsedAt: 5,
    impCount: 2,
    isPinned: true,
  });
});
