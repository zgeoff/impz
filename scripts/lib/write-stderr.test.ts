import { expect, test } from 'bun:test';

test('it writes the text to stderr as it is, with no newline added', () => {
  const module = new URL('write-stderr.ts', import.meta.url).pathname;

  const result = Bun.spawnSync([
    process.execPath,
    '-e',
    `const { writeStderr } = await import(${JSON.stringify(module)}); writeStderr('no newline');`,
  ]);

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: '',
    stderr: 'no newline',
  });
});
