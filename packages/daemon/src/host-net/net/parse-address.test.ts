import { expect, test } from 'bun:test';
import { parseAddress } from './parse-address';

test.each([
  ['10.0.0.1', '10.0.0.1'],
  ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
  ['::ffff:10.0.0.1', '::ffff:a00:1'],
  ['::10.0.0.1', '::a00:1'],
  ['64:ff9b::192.0.2.33', '64:ff9b::c000:221'],
])('it reads %s as %s', (text, written) => {
  expect(parseAddress(text)?.toString()).toBe(written);
});

test.each([
  ['127.1', 'a short IPv4 form'],
  ['0x7f.0.0.1', 'a hex IPv4 octet'],
  ['010.0.0.1', 'a zero-led IPv4 octet'],
  ['10.0.0.256', 'an IPv4 octet over 255'],
  ['::ffff:0x7f.0.0.1', 'a hex octet in an embedded IPv4 part'],
  ['::ffff:127.1', 'a short embedded IPv4 part'],
  ['fe80::1%eth0', 'a zone'],
  ['[::1]', 'brackets'],
  ['1::2::3', 'two gaps'],
  ['1:2:3:4:5:6:7:8:9', 'nine groups'],
  ['example.com', 'a name'],
  ['', 'nothing'],
])('it reads no address from %p, %s', (text) => {
  expect(parseAddress(text)).toBeNull();
});
