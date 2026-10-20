import { expect, test } from 'bun:test';
import { encodeDnsName, encodeDnsUint16 } from './write-dns-wire';

test('#encodeDnsName writes each label after its length, and a zero byte last', () => {
  expect(encodeDnsName('a.test')).toStrictEqual([1, 0x61, 4, 0x74, 0x65, 0x73, 0x74, 0]);
});

test('#encodeDnsName writes a trailing dot as the root it already ends in', () => {
  expect(encodeDnsName('a.test.')).toStrictEqual([1, 0x61, 4, 0x74, 0x65, 0x73, 0x74, 0]);
});

test('#encodeDnsUint16 writes the high byte first', () => {
  expect(encodeDnsUint16(0x12_34)).toStrictEqual([0x12, 0x34]);
});
