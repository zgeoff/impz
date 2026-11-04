import { expect, test } from 'bun:test';
import { collectStaleTemplateFiles } from './collect-stale-template-files';

test('it collects only the stale files of the cache', () => {
  const files = [
    { name: '003_add_broker-0123456789abcdef.sqlite', ageMs: 7_200_000, isOwnerGone: false },
    { name: '003_add_broker-0123456789abcdef.sqlite.lock', ageMs: 1000, isOwnerGone: true },
    { name: '003_add_broker-fedcba9876543210.sqlite', ageMs: 7_200_000, isOwnerGone: false },
    { name: '003_add_broker-fedcba9876543210.sqlite.lock', ageMs: 1000, isOwnerGone: false },
  ];

  expect(collectStaleTemplateFiles(files, '0123456789abcdef')).toStrictEqual([
    { name: '003_add_broker-0123456789abcdef.sqlite.lock', ageMs: 1000, isOwnerGone: true },
    { name: '003_add_broker-fedcba9876543210.sqlite', ageMs: 7_200_000, isOwnerGone: false },
  ]);
});

test('it collects nothing from an empty cache', () => {
  expect(collectStaleTemplateFiles([], '0123456789abcdef')).toStrictEqual([]);
});
