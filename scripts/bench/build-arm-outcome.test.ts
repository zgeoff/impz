import { expect, test } from 'bun:test';
import { buildArmOutcome } from './build-arm-outcome';

test('it keeps the report of an arm that passed, with no note', () => {
  expect(
    buildArmOutcome(
      { arm: 'candidate', run: 'candidate-1' },
      { json: '{"results":[]}\n', isPassed: true },
    ),
  ).toStrictEqual({
    saved: '{"results":[]}\n',
    report: { arm: 'candidate', json: '{"results":[]}\n' },
    isFailed: false,
    notes: [],
  });
});

test('it keeps the report of an arm that failed, and fails the arm', () => {
  expect(
    buildArmOutcome(
      { arm: 'candidate', run: 'candidate-2' },
      { json: '{"results":[]}\n', isPassed: false },
    ),
  ).toStrictEqual({
    saved: '{"results":[]}\n',
    report: { arm: 'candidate', json: '{"results":[]}\n' },
    isFailed: true,
    notes: ['bench arms: candidate-2 failed; its impd log is in candidate-2.impd.log'],
  });
});

test('it saves a report that does not parse, leaves it out of the table, and fails the arm', () => {
  expect(
    buildArmOutcome(
      { arm: 'baseline', run: 'baseline-1' },
      { json: 'impd: listen EADDRINUSE\n', isPassed: true },
    ),
  ).toStrictEqual({
    saved: 'impd: listen EADDRINUSE\n',
    report: null,
    isFailed: true,
    notes: [
      'bench arms: baseline-1 printed a report that does not parse',
      'bench arms: baseline-1 failed; its impd log is in baseline-1.impd.log',
    ],
  });
});

test('it saves nothing for an arm that printed no report, and fails the arm', () => {
  expect(
    buildArmOutcome({ arm: 'baseline', run: 'baseline-3' }, { json: null, isPassed: false }),
  ).toStrictEqual({
    saved: null,
    report: null,
    isFailed: true,
    notes: [
      'bench arms: baseline-3 printed no report',
      'bench arms: baseline-3 failed; its impd log is in baseline-3.impd.log',
    ],
  });
});

test('it fails an arm that exited 0 but printed no report', () => {
  expect(
    buildArmOutcome({ arm: 'candidate', run: 'candidate-4' }, { json: null, isPassed: true }),
  ).toStrictEqual({
    saved: null,
    report: null,
    isFailed: true,
    notes: [
      'bench arms: candidate-4 printed no report',
      'bench arms: candidate-4 failed; its impd log is in candidate-4.impd.log',
    ],
  });
});
