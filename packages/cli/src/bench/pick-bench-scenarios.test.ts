import { expect, test } from 'bun:test';
import { BENCH_SCENARIOS } from './bench-scenarios';
import { pickBenchScenarios } from './pick-bench-scenarios';

test('it picks the named scenarios in the order the list names them', () => {
  const picked = pickBenchScenarios('restore, create', BENCH_SCENARIOS);

  expect(picked.map((scenario) => scenario.name)).toStrictEqual(['restore', 'create']);
});

test('it refuses a name no scenario has, and lists the names it knows', () => {
  expect(() => pickBenchScenarios('create,boot', BENCH_SCENARIOS)).toThrowWithMessage(
    Error,
    'no bench scenario boot; pick from create, wake, wake-young, restore, sleep',
  );
});
