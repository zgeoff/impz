import { expect, test } from 'bun:test';

test('it writes the line to stdout with a newline after it', () => {
  const module = new URL('write-stdout-line.ts', import.meta.url).pathname;

  const result = Bun.spawnSync([
    process.execPath,
    '-e',
    `const { writeStdoutLine } = await import(${JSON.stringify(module)}); writeStdoutLine('one line');`,
  ]);

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: 'one line\n',
    stderr: '',
  });
});
