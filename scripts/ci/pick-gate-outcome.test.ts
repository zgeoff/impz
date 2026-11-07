import { expect, test } from 'bun:test';
import { isRunReplaced, pickGateOutcome } from './pick-gate-outcome';

test.each([
  {
    title: 'every job passed',
    needs: { 'checks-unit': { result: 'success' }, 'checks-lanes': { result: 'success' } },
    outcome: 'pass',
  },
  {
    title: 'a job failed',
    needs: { 'checks-unit': { result: 'failure' }, 'checks-lanes': { result: 'success' } },
    outcome: 'fail',
  },
  {
    title: 'a job was cancelled',
    needs: { 'checks-unit': { result: 'cancelled' }, 'checks-lanes': { result: 'success' } },
    outcome: 'replaced',
  },
  {
    title: 'a job was cancelled and another failed',
    needs: { 'checks-unit': { result: 'cancelled' }, 'checks-lanes': { result: 'failure' } },
    outcome: 'fail',
  },
  {
    title: 'a job skipped with its paths changed',
    needs: {
      changes: { result: 'success', outputs: { changed: 'true' } },
      'e2e-group': { result: 'skipped' },
    },
    outcome: 'fail',
  },
  {
    title: 'the paths changed and every job passed',
    needs: {
      changes: { result: 'success', outputs: { changed: 'true' } },
      'e2e-group': { result: 'success' },
    },
    outcome: 'pass',
  },
  {
    title: 'no path changed and every job skipped',
    needs: {
      changes: { result: 'success', outputs: { changed: 'false' } },
      'e2e-group': { result: 'skipped' },
    },
    outcome: 'pass',
  },
  {
    title: 'no path changed and a job ran',
    needs: {
      changes: { result: 'success', outputs: { changed: 'false' } },
      'e2e-group': { result: 'success' },
    },
    outcome: 'fail',
  },
  {
    title: 'the changes job was cancelled and the jobs after it skipped',
    needs: { changes: { result: 'cancelled' }, 'e2e-group': { result: 'skipped' } },
    outcome: 'replaced',
  },
  {
    title: 'the changes job failed and the jobs after it skipped',
    needs: { changes: { result: 'failure' }, 'e2e-group': { result: 'skipped' } },
    outcome: 'fail',
  },
])('#pickGateOutcome answers $outcome when $title', (row) => {
  expect(pickGateOutcome(row.needs)).toBe(row.outcome);
});

test.each([
  { title: 'a newer run', runIds: [40, 41, 42], replaced: true },
  { title: 'only this run and older ones', runIds: [40, 41], replaced: false },
  { title: 'no run', runIds: [], replaced: false },
])('#isRunReplaced answers $replaced for run 41 with $title', (row) => {
  expect(isRunReplaced(row.runIds, 41)).toBe(row.replaced);
});
