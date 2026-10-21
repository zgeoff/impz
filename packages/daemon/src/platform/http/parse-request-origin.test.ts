import { expect, test } from 'bun:test';
import { parseRequestOrigin } from './parse-request-origin';

test.each([
  ['no header', {}, { fromBrowser: false, site: null, origin: null }],
  [
    'a fetch site only',
    { 'sec-fetch-site': 'same-origin' },
    { fromBrowser: true, site: 'same-origin', origin: null },
  ],
  [
    'an origin only',
    { origin: 'https://imp.example.test' },
    { fromBrowser: true, site: null, origin: 'https://imp.example.test' },
  ],
  [
    'both headers',
    { 'sec-fetch-site': 'cross-site', origin: 'null' },
    { fromBrowser: true, site: 'cross-site', origin: 'null' },
  ],
])('it parses %s', (_kind, headers, expected) => {
  const request = new Request('https://imp.example.test/', { headers });

  expect(parseRequestOrigin(request)).toStrictEqual(expected);
});
