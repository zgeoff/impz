import { expect, test } from 'bun:test';
import { buildMockOperation } from '../test-utils/build-mock-operation';
import { buildMockOperationStep } from '../test-utils/build-mock-operation-step';
import { pickNextMove } from './pick-next-move';

test.each(['succeeded', 'failed', 'cancelled', 'unknown'] as const)(
  'it picks done for an operation that ended %s',
  (state) => {
    const move = pickNextMove(buildMockOperation({ state }), new Set());

    expect(move).toStrictEqual({ kind: 'done' });
  },
);

test.each([
  { cancelRequested: false, kind: 'start' },
  { cancelRequested: true, kind: 'cancel-queued' },
])('it picks $kind for a queued operation with cancelRequested $cancelRequested', (row) => {
  const move = pickNextMove(
    buildMockOperation({ state: 'queued', cancelRequested: row.cancelRequested }),
    new Set(),
  );

  expect(move).toStrictEqual({ kind: row.kind });
});

test('it picks the first step that has not succeeded', () => {
  const cut = buildMockOperationStep({ position: 1, name: 'cut' });

  const operation = buildMockOperation({
    steps: [buildMockOperationStep({ position: 0, name: 'measure', state: 'succeeded' }), cut],
  });

  const move = pickNextMove(operation, new Set());

  expect(move).toStrictEqual({ kind: 'run-step', step: cut });
});

test('it picks a running step again to rerun it', () => {
  const cut = buildMockOperationStep({ name: 'cut', state: 'running' });
  const move = pickNextMove(buildMockOperation({ steps: [cut] }), new Set());

  expect(move).toStrictEqual({ kind: 'run-step', step: cut });
});

test('it picks the end once every step succeeded', () => {
  const operation = buildMockOperation({
    steps: [buildMockOperationStep({ name: 'cut', state: 'succeeded' })],
  });

  const move = pickNextMove(operation, new Set());

  expect(move).toStrictEqual({ kind: 'end', state: 'succeeded' });
});

test('it picks begin-cancel for a running operation with a cancel request', () => {
  const operation = buildMockOperation({
    cancelRequested: true,
    steps: [buildMockOperationStep({ name: 'cut' })],
  });

  const move = pickNextMove(operation, new Set());

  expect(move).toStrictEqual({ kind: 'begin-cancel' });
});

test('it picks the last step to undo first while an operation ends', () => {
  const cut = buildMockOperationStep({ position: 1, name: 'cut', state: 'succeeded' });

  const operation = buildMockOperation({
    ending: 'failed',
    steps: [buildMockOperationStep({ position: 0, name: 'measure', state: 'succeeded' }), cut],
  });

  const move = pickNextMove(operation, new Set(['measure', 'cut']));

  expect(move).toStrictEqual({ kind: 'undo-step', step: cut });
});

test.each([
  { label: 'a step with no undo', step: { state: 'succeeded' }, undoable: [] },
  { label: 'a step already undone', step: { state: 'succeeded', undoneAt: 1 }, undoable: ['cut'] },
  { label: 'a failed step with no undo record', step: { state: 'failed' }, undoable: ['cut'] },
  {
    label: 'a queued step',
    step: { state: 'queued', undoRecord: { step: 'cut' } },
    undoable: ['cut'],
  },
] as const)('it skips $label while an operation ends', (row) => {
  const operation = buildMockOperation({
    ending: 'cancelled',
    steps: [buildMockOperationStep({ name: 'cut', ...row.step })],
  });

  const move = pickNextMove(operation, new Set<string>(row.undoable));

  expect(move).toStrictEqual({ kind: 'end', state: 'cancelled' });
});

test('it picks the undo of a failed step that wrote an undo record', () => {
  const cut = buildMockOperationStep({ name: 'cut', state: 'failed', undoRecord: { step: 'cut' } });

  const move = pickNextMove(
    buildMockOperation({ ending: 'failed', steps: [cut] }),
    new Set(['cut']),
  );

  expect(move).toStrictEqual({ kind: 'undo-step', step: cut });
});
