import type { StubCall } from '@zgeoff/testing/bin';

// One line per call, the command and its arguments, so a test lists the calls it expects as text.
// A call that recorded its input has a `< ` line for each line it read, and a call that recorded
// variables has an indented line of them, `NAME=value`, after its own.
export function formatStubCalls(calls: readonly StubCall[]): string {
  const lines = calls.flatMap((call) => {
    const input = call.stdin === '' ? [] : call.stdin.replace(/\n$/u, '').split('\n');
    const variables = Object.entries(call.env).map(([name, value]) => `${name}=${value}`);

    return [
      `${call.name} ${call.argv.join(' ')}`,
      ...input.map((each) => `< ${each}`),
      ...(variables.length === 0 ? [] : [`  ${variables.join(' ')}`]),
    ];
  });

  return lines.map((line) => `${line}\n`).join('');
}
