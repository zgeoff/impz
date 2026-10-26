import { expect, test } from 'bun:test';
import { parseNetworkNames } from './parse-network-names';

test('it parses the network names in sorted order', () => {
  expect(
    parseNetworkNames(
      '{"imp-host":{"IPAddress":"172.20.0.2"},"bridge":{"IPAddress":"172.17.0.2"}}',
    ),
  ).toStrictEqual(['bridge', 'imp-host']);
});

test('it parses a container on no network as none', () => {
  expect(parseNetworkNames('{}')).toStrictEqual([]);
});

test('it refuses output that is not an object of networks', () => {
  expect(() => parseNetworkNames('["bridge"]')).toThrow();
});
