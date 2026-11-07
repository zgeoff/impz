import { expect, test } from 'bun:test';
import { findNewerRunId, pickGateOutcome } from './pick-gate-outcome';

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
  { title: 'a newer run', runIds: [42, 41, 40], newer: 42 },
  { title: 'only this run and older ones', runIds: [41, 40], newer: null },
  { title: 'no run', runIds: [], newer: null },
])('#findNewerRunId finds $newer for run 41 with $title', (row) => {
  expect(findNewerRunId(row.runIds, 41)).toBe(row.newer);
});
