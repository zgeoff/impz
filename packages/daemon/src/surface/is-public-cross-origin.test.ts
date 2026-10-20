import { expect, test } from 'bun:test';
import { isPublicCrossOrigin } from './is-public-cross-origin';

test.each([
  ['a request that names no page', {}, false],
  [
    'a same-origin fetch',
    { 'sec-fetch-site': 'same-origin', origin: 'https://imp.example.test' },
    false,
  ],
  ['the route’s own origin with no fetch site', { origin: 'https://imp.example.test' }, false],
  ['another site', { 'sec-fetch-site': 'cross-site', origin: 'https://other.example.test' }, true],
  ['a same-site page', { 'sec-fetch-site': 'same-site', origin: 'https://imp.example.test' }, true],
  ['a fetch site with no origin', { 'sec-fetch-site': 'same-origin' }, true],
  ['an origin that differs only in case', { origin: 'https://IMP.example.test' }, true],
  ['an origin with a trailing slash', { origin: `https://imp.example.test/` }, true],
  ['an origin with another port', { origin: `https://imp.example.test:8443` }, true],
  ['the null origin', { origin: 'null' }, true],
])(
  'it counts a request as cross-origin unless the route’s own origin sent it, given %s',
  (_kind, headers, expected) => {
    const request = new Request(`https://imp.example.test/mcp`, { headers });

    const isCross = isPublicCrossOrigin(request, 'https://imp.example.test');

    expect(isCross).toBe(expected);
  },
);
