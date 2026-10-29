import { expect, test } from 'bun:test';
import { pickWakeHugePages } from './pick-wake-huge-pages';

test.each([
  ['an unrecorded snapshot with huge pages on', undefined, true, null],
  ['a host-page snapshot with huge pages on', 'None', true, null],
  ['a host-page snapshot with huge pages off', 'None', false, null],
  ['a 2M snapshot with huge pages on', '2M', true, '2M'],
  ['a 2M snapshot with huge pages off', '2M', false, 'None'],
] as const)('it wakes %s on %p', (_label, recorded, isOn, expected) => {
  expect(pickWakeHugePages(recorded, isOn)).toBe(expected);
});
