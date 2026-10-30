import { expect, mock, test } from 'bun:test';
import { runBenchComparison } from './run-bench-comparison';

test('it saves the report of an arm that failed, and fails the comparison', async () => {
  const writeReport = mock<(path: string, json: string) => void>(() => {});

  const code = await runBenchComparison(
    {
      runArm: () => Promise.resolve({ json: '{"results":[]}\n', isPassed: false }),
      makeDirectory: () => {},
      writeReport,
      appendSummary: null,
      print: () => {},
      printError: () => {},
    },
    {
      arms: [{ name: 'candidate', checkout: '.' }],
      rounds: 1,
      out: '/work/out',
      benchArgs: ['wake'],
      warmUpArgs: ['bench', 'create'],
    },
  );

  expect(writeReport).toHaveBeenCalledExactlyOnceWith(
    '/work/out/candidate-1.json',
    '{"results":[]}\n',
  );

  expect(code).toBe(1);
});

test('it passes a comparison whose every arm passed, and adds the table to the summary', async () => {
  const appendSummary = mock<(text: string) => void>(() => {});

  const code = await runBenchComparison(
    {
      runArm: () => Promise.resolve({ json: '{"results":[]}\n', isPassed: true }),
      makeDirectory: () => {},
      writeReport: () => {},
      appendSummary,
      print: () => {},
      printError: () => {},
    },
    {
      arms: [
        { name: 'baseline', checkout: '/work/baseline' },
        { name: 'candidate', checkout: '.' },
      ],
      rounds: 1,
      out: '/work/out',
      benchArgs: ['wake'],
      warmUpArgs: ['bench', 'create'],
    },
  );

  expect(code).toBe(0);
  expect(appendSummary).toHaveBeenCalledOnce();
});
