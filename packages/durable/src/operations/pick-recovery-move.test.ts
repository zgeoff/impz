import { expect, test } from 'bun:test';
import { buildMockOperation } from '../test-utils/build-mock-operation';
import { buildMockOperationStep } from '../test-utils/build-mock-operation-step';
import { pickRecoveryMove } from './pick-recovery-move';

test.each([
  { label: 'a queued operation', state: 'queued', ending: null, stepState: 'queued', rule: 'fail' },
  {
    label: 'an operation that is ending',
    state: 'running',
    ending: 'failed',
    stepState: 'running',
    rule: 'fail',
  },
  {
    label: 'an operation with no running step',
    state: 'running',
    ending: null,
    stepState: 'succeeded',
    rule: 'fail',
  },
  {
    label: 'a running step that reruns',
    state: 'running',
    ending: null,
    stepState: 'running',
    rule: 'rerun',
  },
] as const)('it picks resume for $label', (row) => {
  const operation = buildMockOperation({
    state: row.state,
    ending: row.ending,
    steps: [buildMockOperationStep({ name: 'cut', state: row.stepState })],
  });

  const move = pickRecoveryMove(operation, new Map([['cut', row.rule]]));

  expect(move).toStrictEqual({ kind: 'resume' });
});

test('it picks resume for a running step of a kind with no restart rule', () => {
  const operation = buildMockOperation({
    state: 'running',
    steps: [buildMockOperationStep({ name: 'cut', state: 'running' })],
  });

  const move = pickRecoveryMove(operation, new Map());

  expect(move).toStrictEqual({ kind: 'resume' });
});

test.each([
  { rule: 'fail', kind: 'fail-step' },
  { rule: 'unknown', kind: 'unknown-step' },
] as const)('it picks $kind for a running step with the $rule rule', (row) => {
  const cut = buildMockOperationStep({ name: 'cut', state: 'running' });

  const move = pickRecoveryMove(
    buildMockOperation({ state: 'running', steps: [cut] }),
    new Map([['cut', row.rule]]),
  );

  expect(move).toStrictEqual({ kind: row.kind, step: cut });
});
