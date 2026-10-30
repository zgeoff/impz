import { expect, test } from 'bun:test';
import { pickRestoreFailureOutcome } from './pick-restore-failure-outcome';

test.each([
  {
    label: 'a failure after the claim',
    facts: { fault: null, isCurrentBuild: true, restoredBefore: 0, restoredNow: 0 },
    failuresBefore: 0,
    isOff: false,
    outcome: 'ignore',
  },
  {
    label: 'a load failure of a build that is no longer current',
    facts: { fault: 'load', isCurrentBuild: false, restoredBefore: 0, restoredNow: 0 },
    failuresBefore: 0,
    isOff: false,
    outcome: 'ignore',
  },
  {
    label: 'an agent timeout of a build that is no longer current',
    facts: { fault: 'agent', isCurrentBuild: false, restoredBefore: 0, restoredNow: 1 },
    failuresBefore: 0,
    isOff: false,
    outcome: 'ignore',
  },
  {
    label: 'an agent timeout while another restore succeeded',
    facts: { fault: 'agent', isCurrentBuild: true, restoredBefore: 2, restoredNow: 3 },
    failuresBefore: 2,
    isOff: false,
    outcome: 'keep',
  },
  {
    label: 'an agent timeout with no restore succeeding',
    facts: { fault: 'agent', isCurrentBuild: true, restoredBefore: 2, restoredNow: 2 },
    failuresBefore: 0,
    isOff: false,
    outcome: 'remove',
  },
  {
    label: 'a load failure while another restore succeeded',
    facts: { fault: 'load', isCurrentBuild: true, restoredBefore: 2, restoredNow: 3 },
    failuresBefore: 0,
    isOff: false,
    outcome: 'remove',
  },
  {
    label: 'a second failure in a row',
    facts: { fault: 'load', isCurrentBuild: true, restoredBefore: 0, restoredNow: 0 },
    failuresBefore: 1,
    isOff: false,
    outcome: 'remove',
  },
  {
    label: 'a third failure in a row',
    facts: { fault: 'load', isCurrentBuild: true, restoredBefore: 0, restoredNow: 0 },
    failuresBefore: 2,
    isOff: false,
    outcome: 'disable',
  },
  {
    label: 'a third agent timeout in a row',
    facts: { fault: 'agent', isCurrentBuild: true, restoredBefore: 0, restoredNow: 0 },
    failuresBefore: 2,
    isOff: false,
    outcome: 'disable',
  },
  {
    label: 'a failure of a template already off',
    facts: { fault: 'load', isCurrentBuild: true, restoredBefore: 0, restoredNow: 0 },
    failuresBefore: 3,
    isOff: true,
    outcome: 'remove',
  },
] as const)('it picks the outcome of $label', (row) => {
  expect(
    pickRestoreFailureOutcome({
      ...row.facts,
      failuresBefore: row.failuresBefore,
      isOff: row.isOff,
    }),
  ).toBe(row.outcome);
});
