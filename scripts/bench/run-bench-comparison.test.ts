import { expect, mock, test } from 'bun:test';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
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

test('it runs the arms after one that stopped, writes the table, and fails the comparison', async () => {
  const runs = buildStubAnswerQueue([
    () => Promise.reject(new Error('bench arms: imp-dev already runs')),
    () => Promise.resolve({ json: '{"results":[]}\n', isPassed: true }),
  ]);

  const runArm = mock(() => runs.next()());
  const appendSummary = mock<(text: string) => void>(() => {});
  const printError = mock<(text: string) => void>(() => {});

  const code = await runBenchComparison(
    {
      runArm,
      makeDirectory: () => {},
      writeReport: () => {},
      appendSummary,
      print: () => {},
      printError,
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

  expect(code).toBe(1);
  expect(runArm).toHaveBeenCalledTimes(2);
  expect(appendSummary).toHaveBeenCalledOnce();

  expect(printError).toHaveBeenCalledWith(
    'bench arms: baseline-1 stopped: bench arms: imp-dev already runs',
  );
});

test('it leaves a report that does not parse out of the table, and fails the comparison', async () => {
  const runs = buildStubAnswerQueue([
    { json: 'impd: listen EADDRINUSE\n', isPassed: true },
    {
      json: '{"results":[{"scenario":"wake","concurrency":1,"samples":3,"failures":{},"impdMs":null,"memFileMib":null,"latencyMs":{"p50":200,"p95":210,"p99":220,"max":220}}]}\n',
      isPassed: true,
    },
  ]);

  const print = mock<(text: string) => void>(() => {});
  const printError = mock<(text: string) => void>(() => {});

  const code = await runBenchComparison(
    {
      runArm: () => Promise.resolve(runs.next()),
      makeDirectory: () => {},
      writeReport: () => {},
      appendSummary: null,
      print,
      printError,
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

  expect(code).toBe(1);

  expect(print).toHaveBeenCalledExactlyOnceWith(
    '| scenario | conc | candidate p50 | candidate p95 | candidate p99 | candidate failed |\n| --- | --- | --- | --- | --- | --- |\n| wake | 1 | 200ms | 210ms | 220ms | 0 |',
  );

  expect(printError).toHaveBeenCalledWith(
    'bench arms: baseline-1 printed a report that does not parse',
  );
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
