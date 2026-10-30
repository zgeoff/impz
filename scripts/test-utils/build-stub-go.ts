import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubGoAnswer {
  readonly stdout?: string;
  readonly exitCode?: number;
}

// `go -C <module> ...` answers with the given module's output and exit code, and every other call
// passes with no output.
export function buildStubGo(answers: Readonly<Record<string, StubGoAnswer>>): string {
  const cases = Object.entries(answers).map(([module, answer]) => {
    const print =
      answer.stdout === undefined ? '' : `printf '%s\\n' ${formatShellWord(answer.stdout)}; `;

    return `  ${formatShellWord(module)}) ${print}exit ${String(answer.exitCode ?? 0)} ;;`;
  });

  return ['[ "$1" = -C ] || exit 0', 'case "$2" in', ...cases, 'esac', 'exit 0'].join('\n');
}
