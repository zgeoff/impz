import { expect, test } from 'bun:test';
import { isPublicCrossOrigin } from './is-public-cross-origin';

const ORIGIN = 'https://imp.example.test';

test.each([
  ['a request that names no page', {}, false],
  ['a same-origin fetch', { 'sec-fetch-site': 'same-origin', origin: ORIGIN }, false],
  ['the route’s own origin with no fetch site', { origin: ORIGIN }, false],
  ['another site', { 'sec-fetch-site': 'cross-site', origin: 'https://other.example.test' }, true],
  ['a same-site page', { 'sec-fetch-site': 'same-site', origin: ORIGIN }, true],
  ['a fetch site with no origin', { 'sec-fetch-site': 'same-origin' }, true],
  ['an origin that differs only in case', { origin: 'https://IMP.example.test' }, true],
  ['an origin with a trailing slash', { origin: `${ORIGIN}/` }, true],
  ['an origin with another port', { origin: `${ORIGIN}:8443` }, true],
  ['the null origin', { origin: 'null' }, true],
])('#isPublicCrossOrigin judges %s', (_kind, headers, expected) => {
  const request = new Request(`${ORIGIN}/mcp`, { headers });

  const isCross = isPublicCrossOrigin(request, ORIGIN);

  expect(isCross).toBe(expected);
});
