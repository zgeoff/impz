import { expect, test } from 'bun:test';
import { buildMockImageUse } from '../../../testing/imps/build-mock-image-use';
import { pickPrunedImages } from './pick-pruned-images';

test('it removes the unused agent images past the newest two, oldest last use first', () => {
  const uses = [
    buildMockImageUse({ name: 'agent-1111111', lastUsedAt: Date.parse('2026-09-01T00:00:00Z') }),
    buildMockImageUse({ name: 'agent-2222222', lastUsedAt: Date.parse('2026-09-05T00:00:00Z') }),
    buildMockImageUse({ name: 'agent-3333333', lastUsedAt: Date.parse('2026-09-09T00:00:00Z') }),
    buildMockImageUse({ name: 'agent-4444444', lastUsedAt: Date.parse('2026-09-12T00:00:00Z') }),
  ];

  const plan = pickPrunedImages(
    uses,
    new Set(),
    { prefix: 'agent-', rollbackCount: 2 },
    Date.parse('2026-10-01T00:00:00Z'),
  );

  expect(plan.removed.map((use) => use.name)).toStrictEqual(['agent-2222222', 'agent-1111111']);
});

test('it never removes an image an imp uses, however old, nor counts it as a rollback', () => {
  const uses = [
    buildMockImageUse({
      id: 'used',
      name: 'agent-1111111',
      lastUsedAt: Date.parse('2026-01-01T00:00:00Z'),
      impCount: 1,
    }),
    buildMockImageUse({ name: 'agent-2222222', lastUsedAt: Date.parse('2026-09-05T00:00:00Z') }),
    buildMockImageUse({ name: 'agent-3333333', lastUsedAt: Date.parse('2026-09-09T00:00:00Z') }),
  ];

  const plan = pickPrunedImages(
    uses,
    new Set(),
    { prefix: 'agent-', rollbackCount: 1 },
    Date.parse('2026-10-01T00:00:00Z'),
  );

  expect(plan.removed.map((use) => use.name)).toStrictEqual(['agent-2222222']);
  expect(plan.usedIDs).toStrictEqual(['used']);
});

test('it never removes an image a kept name holds', () => {
  const uses = [
    buildMockImageUse({
      id: 'kept',
      name: 'agent-1111111',
      lastUsedAt: Date.parse('2026-01-01T00:00:00Z'),
    }),
    buildMockImageUse({ name: 'agent-2222222', lastUsedAt: Date.parse('2026-09-05T00:00:00Z') }),
  ];

  const plan = pickPrunedImages(
    uses,
    new Set(['agent-1111111']),
    { prefix: 'agent-', rollbackCount: 0 },
    Date.parse('2026-10-01T00:00:00Z'),
  );

  expect(plan.removed.map((use) => use.name)).toStrictEqual(['agent-2222222']);
  expect(plan.usedIDs).toStrictEqual(['kept']);
});

test('it never removes a template or an image outside the prefix', () => {
  const uses = [
    buildMockImageUse({
      name: 'agent-template',
      source: 'imp',
      lastUsedAt: Date.parse('2026-01-01T00:00:00Z'),
    }),
    buildMockImageUse({ name: 'ubuntu', lastUsedAt: Date.parse('2026-01-01T00:00:00Z') }),
  ];

  const plan = pickPrunedImages(
    uses,
    new Set(),
    { prefix: 'agent-', rollbackCount: 0 },
    Date.parse('2026-10-01T00:00:00Z'),
  );

  expect(plan.removed).toStrictEqual([]);
});

test('it keeps an unused image past the rollback count while its last use is under an hour old', () => {
  const uses = [
    buildMockImageUse({ name: 'agent-1111111', lastUsedAt: Date.parse('2026-10-01T00:00:00Z') }),
    buildMockImageUse({ name: 'agent-2222222', lastUsedAt: Date.parse('2026-09-30T23:30:00Z') }),
    buildMockImageUse({ name: 'agent-3333333', lastUsedAt: Date.parse('2026-09-30T22:59:59Z') }),
  ];

  const plan = pickPrunedImages(
    uses,
    new Set(),
    { prefix: 'agent-', rollbackCount: 1 },
    Date.parse('2026-10-01T00:00:00Z'),
  );

  expect(plan.removed.map((use) => use.name)).toStrictEqual(['agent-3333333']);
});
