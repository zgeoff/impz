import { expect, test } from 'bun:test';
import { buildMockOperationStep } from './build-mock-operation-step';

test('it builds a queued step with no undo record', () => {
  const step = buildMockOperationStep();

  expect(step).toStrictEqual(
    expect.objectContaining({ state: 'queued', undoRecord: null, undoneAt: null }),
  );
});

test('it keeps the fields the caller gives', () => {
  const step = buildMockOperationStep({ name: 'measure', state: 'succeeded' });

  expect(step).toStrictEqual(expect.objectContaining({ name: 'measure', state: 'succeeded' }));
});
