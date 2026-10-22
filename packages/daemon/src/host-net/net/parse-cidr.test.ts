import { expect, test } from 'bun:test';
import { parseCidr } from './parse-cidr';

test.each([
  ['10.0.0.0/8', '10.0.0.0', 8],
  ['10.0.0.9', '10.0.0.9', 32],
  ['fc00::/7', 'fc00::', 7],
  ['2001:db8::1', '2001:db8::1', 128],
  ['::/0', '::', 0],
])('it reads %s as %s with %d prefix bits', (text, address, bits) => {
  const cidr = parseCidr(text);

  expect({ address: cidr?.address.toString(), bits: cidr?.bits }).toStrictEqual({ address, bits });
});

test.each([
  '10.0.0.0/33',
  '10.0.0.0/',
  '10.0.0.0/-1',
  '10.0.0.0/x',
  '10.0.0.0/8/1',
  'fc00::/129',
  'fc00::/1.5',
  'example.com/8',
])('it reads no range from %p', (text) => {
  expect(parseCidr(text)).toBeNull();
});
