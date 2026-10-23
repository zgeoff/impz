import { expect, test } from 'bun:test';
import { buildPeerRanges, parsePeerUrlAddress } from './peer-address';

test.each([
  ['100.101.2.3', true],
  ['::ffff:100.101.2.3', true],
  ['fd7a:115c:a1e0::5', true],
  ['10.20.0.4', false],
  ['fd7a:115c:a1e1::5', false],
  ['peer.example', false],
])('it allows %s from the tailnet only: %p', (address, isAllowed) => {
  expect(buildPeerRanges(null).isAllowed(address)).toBe(isAllowed);
});

test.each([
  ['10.20.0.4', true],
  ['::ffff:10.20.0.4', true],
  ['10.21.0.4', false],
])('it allows %s with the test range 10.20.0.0/16: %p', (address, isAllowed) => {
  expect(buildPeerRanges('10.20.0.0/16').isAllowed(address)).toBe(isAllowed);
});

test.each([
  ['http://100.101.2.3:7070', '100.101.2.3'],
  ['http://[fd7a:115c:a1e0::5]:7070', 'fd7a:115c:a1e0::5'],
  ['http://peer.example:7070', null],
])('it reads the address of %s as %p', (url, address) => {
  expect(parsePeerUrlAddress(url)).toBe(address);
});
