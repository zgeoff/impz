import { expect, test } from 'bun:test';
import { formatShellWord } from './format-shell-word';

test('it wraps a plain word in single quotes', () => {
  expect(formatShellWord('imp-dev')).toBe("'imp-dev'");
});

test('it escapes a single quote inside the word', () => {
  expect(formatShellWord("it's")).toBe(String.raw`'it'\''s'`);
});

test.each([
  ['spaces', 'two words'],
  ['a quote', "it's"],
  ['shell syntax', '$(echo no) `echo no` $HOME; *'],
  ['a newline', 'line one\nline two'],
  ['nothing', ''],
])('it gives bash back %s unchanged', (_label, value) => {
  const result = Bun.spawnSync(['bash', '-c', `printf '%s' ${formatShellWord(value)}`]);

  expect(result.stdout.toString()).toBe(value);
});
