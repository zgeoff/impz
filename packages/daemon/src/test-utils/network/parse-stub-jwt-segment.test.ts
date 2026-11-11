import { expect, test } from 'bun:test';
import { buildStubBrokerJwt } from './build-stub-broker-jwt';
import { parseStubJwtSegment } from './parse-stub-jwt-segment';

test('it reads the header of a token', () => {
  const token = buildStubBrokerJwt({ sub: 'a' });

  expect(parseStubJwtSegment(token, 0)).toStrictEqual({ alg: 'none' });
});

test('it reads the claims of a token', () => {
  const token = buildStubBrokerJwt({ sub: 'a' });

  expect(parseStubJwtSegment(token, 1)).toStrictEqual({ sub: 'a' });
});

test('it rejects a segment that is not a JSON object', () => {
  expect(() => parseStubJwtSegment('a.b.c', 1)).toThrow();
});
