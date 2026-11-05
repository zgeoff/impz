import { createStubBin } from '@impz/test-utils/create-stub-bin';
import type { StubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

export interface StubBinAnswer {
  // the leading arguments a call must start with; empty matches every call
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

// The first answer whose args start the call's arguments answers it; a call that no answer
// matches prints nothing and exits 0.
export function createStubAnsweringBin(
  directory: string,
  name: string,
  answers: readonly StubBinAnswer[],
): StubBin {
  return createStubBin(
    directory,
    name,
    `${answers.map((answer) => formatAnswer(answer)).join('\n')}\nexit 0`,
  );
}

function formatAnswer(answer: StubBinAnswer): string {
  const test =
    answer.args.length === 0
      ? 'true'
      : answer.args
          .map((arg, index) => `[ "\${${String(index + 1)}-}" = ${formatShellWord(arg)} ]`)
          .join(' && ');

  return [
    `if ${test}; then`,
    `  printf '%s' ${formatShellWord(answer.stdout ?? '')}`,
    `  printf '%s' ${formatShellWord(answer.stderr ?? '')} >&2`,
    `  exit ${String(answer.exitCode)}`,
    'fi',
  ].join('\n');
}
