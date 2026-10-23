import { expect, test } from 'bun:test';
import { pickSetting } from './pick-setting.ts';

test('it picks a variable that holds a value', () => {
  expect(pickSetting({ IMP_STORAGE_GIB: '64' }, 'IMP_STORAGE_GIB')).toBe('64');
});

test('it counts a variable set empty as unset', () => {
  expect(pickSetting({ IMP_STORAGE_GIB: '' }, 'IMP_STORAGE_GIB')).toBeUndefined();
});

test('it picks nothing for a variable that is missing', () => {
  expect(pickSetting({}, 'IMP_STORAGE_GIB')).toBeUndefined();
});
