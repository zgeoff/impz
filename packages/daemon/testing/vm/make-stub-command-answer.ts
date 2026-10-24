import type { StubAnswer, StubRun } from './build-stub-guest';

export function makeStubCommandAnswer(
  answers: Readonly<Record<string, StubAnswer>>,
  otherwise: StubAnswer,
) {
  const byCommand = new Map(Object.entries(answers));

  return (run: StubRun): StubAnswer => byCommand.get(run.argv[0] ?? '') ?? otherwise;
}
