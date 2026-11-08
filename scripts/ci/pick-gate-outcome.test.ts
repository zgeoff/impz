import { expect, test } from 'bun:test';
import { findNewerRunID, pickGateOutcome } from './pick-gate-outcome';

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
    title: 'the host image build was cancelled and the groups after it skipped',
    needs: {
      changes: { result: 'success', outputs: { changed: 'true' } },
      'host-image': { result: 'cancelled' },
      'e2e-group': { result: 'skipped' },
    },
    outcome: 'replaced',
  },
  {
    title: 'the host image build failed and the groups after it skipped',
    needs: {
      changes: { result: 'success', outputs: { changed: 'true' } },
      'host-image': { result: 'failure' },
      'e2e-group': { result: 'skipped' },
    },
    outcome: 'fail',
  },
  {
    title: 'no path changed, so the host image build and the groups skipped',
    needs: {
      changes: { result: 'success', outputs: { changed: 'false' } },
      'host-image': { result: 'skipped' },
      'e2e-group': { result: 'skipped' },
    },
    outcome: 'pass',
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
  {
    title: 'a newer run',
    runs: [
      { id: 42, event: 'pull_request', headRepositoryID: 7 },
      { id: 41, event: 'pull_request', headRepositoryID: 7 },
    ],
    newer: 42,
  },
  {
    title: 'only this run and older ones',
    runs: [
      { id: 41, event: 'pull_request', headRepositoryID: 7 },
      { id: 40, event: 'pull_request', headRepositoryID: 7 },
    ],
    newer: null,
  },
  { title: 'no run', runs: [], newer: null },
  {
    title: 'a newer run from another event',
    runs: [{ id: 42, event: 'push', headRepositoryID: 7 }],
    newer: null,
  },
  {
    title: 'a newer run from another head repository',
    runs: [{ id: 42, event: 'pull_request', headRepositoryID: 9 }],
    newer: null,
  },
  {
    title: 'a newer run from a deleted fork',
    runs: [{ id: 42, event: 'pull_request', headRepositoryID: null }],
    newer: null,
  },
])('#findNewerRunID finds $newer for a pull request run 41 with $title', (row) => {
  const run = { id: 41, event: 'pull_request', headRepositoryID: 7 };

  expect(findNewerRunID(row.runs, run)).toBe(row.newer);
});
