import { expect, test } from 'bun:test';
import { toPlainOctets } from './to-plain-octets';

test.each([
  ['008.0.0.1', '8.0.0.1'],
  ['010.020.0.0/16', '10.20.0.0/16'],
  ['9.9.9.9', '9.9.9.9'],
  ['300.0.0.1', '300.0.0.1'],
  ['2001:db8::1', '2001:db8::1'],
  ['github.com', 'github.com'],
])('it writes %s as %s', (entry, plain) => {
  expect(toPlainOctets(entry)).toBe(plain);
});
