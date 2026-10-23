import { expect, test } from 'bun:test';
import { parseSecondsSetting } from './parse-seconds-setting.ts';

test('it reads a whole number of seconds', () => {
  expect(
    parseSecondsSetting({ IMP_DEV_READY_TIMEOUT_S: '45' }, 'IMP_DEV_READY_TIMEOUT_S', 600),
  ).toBe(45);
});

test('it reads a fraction of a second', () => {
  expect(parseSecondsSetting({ IMP_DEV_STOP_TIMEOUT_S: '0.5' }, 'IMP_DEV_STOP_TIMEOUT_S', 30)).toBe(
    0.5,
  );
});

test.each([
  ['unset', {}],
  ['set empty', { IMP_DEV_READY_TIMEOUT_S: '' }],
])('it falls back when the setting is %s', (_label, env) => {
  expect(parseSecondsSetting(env, 'IMP_DEV_READY_TIMEOUT_S', 600)).toBe(600);
});

test.each([['oops'], ['-5'], ['Infinity']])('it refuses %s as a number of seconds', (setting) => {
  expect(() =>
    parseSecondsSetting({ IMP_DEV_READY_TIMEOUT_S: setting }, 'IMP_DEV_READY_TIMEOUT_S', 600),
  ).toThrowWithMessage(Error, `IMP_DEV_READY_TIMEOUT_S=${setting} is not a number of seconds`);
});
