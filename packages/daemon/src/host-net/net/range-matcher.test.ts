import { expect, test } from 'bun:test';
import { buildRangeMatcher } from './range-matcher';

test.each([
  ['10.1.2.3', 'an IPv4 address in an IPv4 range', true],
  ['10.255.255.255', 'the last IPv4 address of a range', true],
  ['11.0.0.0', 'the first IPv4 address past a range', false],
  ['8.8.4.4', 'an IPv4 address listed alone', true],
  ['8.8.4.5', 'the IPv4 address after one listed alone', false],
  ['93.184.215.14', 'an IPv4 address that only the mapped IPv6 range holds', false],
  ['010.1.2.3', 'an IPv4 address with a leading zero', false],
  ['10.1', 'a short IPv4 form', false],
  ['0x0a010203', 'a hex IPv4 form', false],
])('it matches %s, %s: %p', (address, _label, isIn) => {
  const isInRanges = buildRangeMatcher(['10.0.0.0/8', '8.8.4.4', '::ffff:0:0/96', 'fc00::/7']);

  expect(isInRanges(address)).toBe(isIn);
});

test.each([
  ['fd00::1', 'an IPv6 address in an IPv6 range', true],
  ['FD00::1', 'an IPv6 address in capitals', true],
  ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'the last IPv6 address of a range', true],
  ['fe00::', 'the first IPv6 address past a range', false],
  ['2001:db8::1', 'an IPv6 address listed alone', true],
  ['2001:db8::2', 'the IPv6 address after one listed alone', false],
  ['2606:4700::1111', 'an IPv6 address outside every range', false],
  ['fd00::1%eth0', 'an IPv6 address with a zone', false],
  ['[fd00::1]', 'a bracketed IPv6 address', false],
  ['example.com', 'a name', false],
  ['', 'an empty string', false],
])('it matches %s, %s: %p', (address, _label, isIn) => {
  const isInRanges = buildRangeMatcher(['fc00::/7', '2001:db8::1']);

  expect(isInRanges(address)).toBe(isIn);
});

test.each([
  ['::ffff:10.1.2.3', 'in an IPv4 range', true],
  ['::ffff:a01:203', 'in an IPv4 range, written in hex groups', true],
  ['::ffff:8.8.8.8', 'outside every IPv4 range', false],
  ['::10.1.2.3', 'IPv4-compatible, not mapped', false],
])('it matches the IPv4-mapped address %s, %s: %p', (address, _label, isIn) => {
  const isInRanges = buildRangeMatcher(['10.0.0.0/8']);

  expect(isInRanges(address)).toBe(isIn);
});

test('it matches an IPv4-mapped address that an IPv6 range holds', () => {
  expect(buildRangeMatcher(['::ffff:0:0/96'])('::ffff:8.8.8.8')).toBeTrue();
});

test('it matches every address of a family for a /0 range', () => {
  const isInRanges = buildRangeMatcher(['0.0.0.0/0']);

  expect(
    ['1.2.3.4', '255.255.255.255', '2606:4700::1111'].map((address) => isInRanges(address)),
  ).toStrictEqual([true, true, false]);
});

test.each([
  '10.0.0.0/33',
  '10.0.0.0/-1',
  '10.0.0.0/8/1',
  'fc00::/129',
  'fc00::/1.5',
  'example.com',
])('it refuses %p as a range', (range) => {
  expect(() => buildRangeMatcher([range])).toThrowWithMessage(
    Error,
    `not an address range: ${range}`,
  );
});
