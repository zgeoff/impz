import { expect, test } from 'bun:test';
import { parseTouchedPagesArgs } from './parse-touched-pages-args';

test('it measures a 1 GiB imp that writes 128 MiB when given no option', () => {
  expect(parseTouchedPagesArgs([])).toStrictEqual({ memory: '1g', memoryMib: 1024, writeMib: 128 });
});

test('it reads the memory and the write size it is given', () => {
  expect(parseTouchedPagesArgs(['--memory', '2g', '--write-mib', '64'])).toStrictEqual({
    memory: '2g',
    memoryMib: 2048,
    writeMib: 64,
  });
});

test.each([
  ['a write size of 0', ['--write-mib', '0']],
  ['a write size that is no number', ['--write-mib', 'lots']],
  ['an option it does not know', ['--huge-pages']],
])('it answers %s with its usage', (_label, argv) => {
  expect(parseTouchedPagesArgs(argv)).toBe(
    'usage: bun scripts/bench/measure-touched-pages.ts [--memory <size>] [--write-mib <n>]',
  );
});

test('it names a memory size it cannot read, then its usage', () => {
  expect(parseTouchedPagesArgs(['--memory', 'big'])).toBe(
    'not a size: big (try 512m, 2g, 1t, or MiB as a whole number)\nusage: bun scripts/bench/measure-touched-pages.ts [--memory <size>] [--write-mib <n>]',
  );
});
