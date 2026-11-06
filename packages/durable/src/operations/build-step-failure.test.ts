import { expect, test } from 'bun:test';
import { buildStepFailure } from './build-step-failure';

test.each([
  {
    label: 'a run that throws',
    isAborted: false,
    phase: 'run',
    ending: 'failed',
    code: 'step_failed',
    isEffectDone: false,
  },
  {
    label: 'a run that a cancel aborts',
    isAborted: true,
    phase: 'run',
    ending: 'cancelled',
    code: 'cancelled',
    isEffectDone: false,
  },
  {
    label: 'a success commit that fails',
    isAborted: false,
    phase: 'commit',
    ending: 'failed',
    code: 'step_failed',
    isEffectDone: true,
  },
  {
    label: 'a success commit that fails after a cancel',
    isAborted: true,
    phase: 'commit',
    ending: 'cancelled',
    code: 'cancelled',
    isEffectDone: true,
  },
] as const)('it builds the failure of $label', (row) => {
  const failure = buildStepFailure({
    cause: new Error('the saw jammed'),
    isAborted: row.isAborted,
    phase: row.phase,
  });

  expect(failure).toStrictEqual({
    ending: row.ending,
    error: { code: row.code, message: 'the saw jammed' },
    isEffectDone: row.isEffectDone,
  });
});
