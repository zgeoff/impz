import { expect, test } from 'bun:test';
import { buildMockCheckpointRecord } from '../../test-utils/imp-ops/build-mock-checkpoint-record';
import { buildMockImpRecord } from '../../test-utils/imps/build-mock-imp-record';
import { isImpSetChange } from './is-imp-set-change';

test('it resyncs the imp set for a create', () => {
  expect(isImpSetChange({ ev: 'ImpAdded', imp: buildMockImpRecord() })).toBeTrue();
});

test('it resyncs the imp set for a destroy', () => {
  expect(isImpSetChange({ ev: 'ImpRemoved', imp: buildMockImpRecord() })).toBeTrue();
});

test.each([
  ['resyncs', 'stopped', true],
  ['leaves alone', 'slept', false],
  ['leaves alone', 'booted', false],
] as const)('it %s the imp set for a %s change', (_verdict, reason, expected) => {
  expect(isImpSetChange({ ev: 'ImpChanged', imp: buildMockImpRecord(), reason })).toBe(expected);
});

test('it leaves the imp set alone for a checkpoint write', () => {
  expect(
    isImpSetChange({
      ev: 'CheckpointAdded',
      name: 'quiet-otter',
      checkpoint: buildMockCheckpointRecord(),
    }),
  ).toBeFalse();
});

test('it leaves the imp set alone for an exec in an agent', () => {
  expect(
    isImpSetChange({
      ev: 'AgentExec',
      name: 'quiet-otter',
      actor: 'token',
      actorName: 'ci',
      tty: false,
      command: 'ls',
    }),
  ).toBeFalse();
});
