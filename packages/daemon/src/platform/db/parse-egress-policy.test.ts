import { expect, test } from 'bun:test';
import { parseEgressPolicy } from './parse-egress-policy';

test('it reads an IPv4 octet with a leading zero as decimal', () => {
  expect(parseEgressPolicy('box', ['008.0.0.1', '010.020.0.0/16', 'github.com'])).toStrictEqual({
    mode: 'box',
    allow: ['8.0.0.1', '10.20.0.0/16', 'github.com'],
  });
});

test('it keeps a policy with plain entries as it is', () => {
  expect(parseEgressPolicy('box', ['9.9.9.9', '2001:db8:c::/48'])).toStrictEqual({
    mode: 'box',
    allow: ['9.9.9.9', '2001:db8:c::/48'],
  });
});

test('it refuses an entry that is no address with its octets read as decimal', () => {
  expect(parseEgressPolicy('box', ['300.0.0.1'])).toBeNull();
});

test('it refuses an unknown mode', () => {
  expect(parseEgressPolicy('wide', [])).toBeNull();
});

test('it refuses an allow-list that is not a list', () => {
  expect(parseEgressPolicy('box', 'github.com')).toBeNull();
});
