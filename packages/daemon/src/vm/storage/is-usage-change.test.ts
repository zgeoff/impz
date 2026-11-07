import { expect, test } from 'bun:test';
import { buildMockCheckpointRecord } from '../../test-utils/imp-ops/build-mock-checkpoint-record';
import { buildMockImpRecord } from '../../test-utils/imps/build-mock-imp-record';
import { isUsageChange } from './is-usage-change';

test.each(['ImpAdded', 'ImpRemoved'] as const)('it counts an %s event', (ev) => {
  expect(isUsageChange({ ev, imp: buildMockImpRecord() })).toBeTrue();
});

test('it counts a checkpoint write', () => {
  expect(
    isUsageChange({
      ev: 'CheckpointRemoved',
      name: 'quiet-otter',
      checkpoint: buildMockCheckpointRecord(),
    }),
  ).toBeTrue();
});

test.each([
  ['resized', true],
  ['slept', true],
  ['stopped', true],
  ['restored', true],
  ['booted', false],
  ['exposed', false],
] as const)('it counts a %s change: %p', (reason, expected) => {
  expect(isUsageChange({ ev: 'ImpChanged', imp: buildMockImpRecord(), reason })).toBe(expected);
});

test('it leaves out a decision of the RAM governor', () => {
  expect(
    isUsageChange({
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'quiet-otter',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    }),
  ).toBeFalse();
});
