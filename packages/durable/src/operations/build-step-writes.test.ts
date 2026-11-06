import { expect, test } from 'bun:test';
import { buildStepWrites } from './build-step-writes';
import type { StepOutcome, StepWrite } from './build-step-writes';

test.each([
  {
    label: 'an effect that ran with no write and no result',
    outcome: { kind: 'effect-ran', hasWrite: false, result: undefined },
    writes: [
      { kind: 'end-step', state: 'succeeded', error: null },
      { kind: 'append-event', state: 'succeeded', error: null },
    ],
  },
  {
    label: 'an effect that ran with a write and a result',
    outcome: { kind: 'effect-ran', hasWrite: true, result: { boards: 4 } },
    writes: [
      { kind: 'end-step', state: 'succeeded', error: null },
      { kind: 'run-step-write' },
      { kind: 'save-result', result: { boards: 4 } },
      { kind: 'append-event', state: 'succeeded', error: null },
    ],
  },
  {
    label: 'an effect that ran with a null result',
    outcome: { kind: 'effect-ran', hasWrite: false, result: null },
    writes: [
      { kind: 'end-step', state: 'succeeded', error: null },
      { kind: 'save-result', result: null },
      { kind: 'append-event', state: 'succeeded', error: null },
    ],
  },
  {
    label: 'an effect that throws',
    outcome: { kind: 'effect-failed', cause: new Error('the saw jammed'), isAborted: false },
    writes: [
      {
        kind: 'end-step',
        state: 'failed',
        error: { code: 'step_failed', message: 'the saw jammed' },
      },
      {
        kind: 'set-ending',
        ending: 'failed',
        error: { code: 'step_failed', message: 'the saw jammed' },
      },
      {
        kind: 'append-event',
        state: 'failed',
        error: { code: 'step_failed', message: 'the saw jammed' },
      },
    ],
  },
  {
    label: 'an effect that a cancel aborts',
    outcome: { kind: 'effect-failed', cause: new Error('the saw jammed'), isAborted: true },
    writes: [
      {
        kind: 'end-step',
        state: 'failed',
        error: { code: 'cancelled', message: 'the saw jammed' },
      },
      {
        kind: 'set-ending',
        ending: 'cancelled',
        error: { code: 'cancelled', message: 'the saw jammed' },
      },
      {
        kind: 'append-event',
        state: 'failed',
        error: { code: 'cancelled', message: 'the saw jammed' },
      },
    ],
  },
  {
    label: 'a success commit that fails',
    outcome: { kind: 'commit-failed', cause: new Error('the disk is full'), isAborted: false },
    writes: [
      { kind: 'mark-effect-done' },
      {
        kind: 'end-step',
        state: 'failed',
        error: { code: 'step_failed', message: 'the disk is full' },
      },
      {
        kind: 'set-ending',
        ending: 'failed',
        error: { code: 'step_failed', message: 'the disk is full' },
      },
      {
        kind: 'append-event',
        state: 'failed',
        error: { code: 'step_failed', message: 'the disk is full' },
      },
    ],
  },
  {
    label: 'a success commit that fails after a cancel',
    outcome: { kind: 'commit-failed', cause: new Error('the disk is full'), isAborted: true },
    writes: [
      { kind: 'mark-effect-done' },
      {
        kind: 'end-step',
        state: 'failed',
        error: { code: 'cancelled', message: 'the disk is full' },
      },
      {
        kind: 'set-ending',
        ending: 'cancelled',
        error: { code: 'cancelled', message: 'the disk is full' },
      },
      {
        kind: 'append-event',
        state: 'failed',
        error: { code: 'cancelled', message: 'the disk is full' },
      },
    ],
  },
] as const satisfies readonly {
  label: string;
  outcome: StepOutcome;
  writes: readonly StepWrite[];
}[])('it plans the writes of $label', (row) => {
  expect(buildStepWrites(row.outcome)).toStrictEqual([...row.writes]);
});
