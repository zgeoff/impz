import { expect, test } from 'bun:test';
import { isAllowedOrigin } from './is-allowed-origin';

test.each([
  ['a same-origin fetch', { 'sec-fetch-site': 'same-origin' }, true],
  ['impd’s own origin with no fetch site', { origin: 'http://imp:7070' }, true],
  ['impd’s host and port over another scheme', { origin: 'https://imp:7070' }, true],
  ['a same-site page', { 'sec-fetch-site': 'same-site' }, false],
  ['a navigation the user typed', { 'sec-fetch-site': 'none' }, false],
  [
    'another site that names impd’s origin',
    { origin: 'http://imp:7070', 'sec-fetch-site': 'cross-site' },
    false,
  ],
  ['an imp’s port with no fetch site', { origin: 'http://imp:20001' }, false],
  ['another host with no fetch site', { origin: 'http://other:7070' }, false],
  ['the null origin', { origin: 'null' }, false],
  ['an origin that is no URL', { origin: 'not a url' }, false],
  ['no origin and no fetch site', {}, false],
])('it answers the same-origin policy for %s with %p', (_kind, headers, expected) => {
  const request = new Request('http://imp:7070/rpc/imps/list', {
    method: 'POST',
    headers: { host: 'imp:7070', ...headers },
  });

  expect(isAllowedOrigin(request, { kind: 'same-origin' })).toBe(expected);
});

test.each([
  ['a client that is no browser', {}, true],
  ['a same-origin fetch', { 'sec-fetch-site': 'same-origin' }, true],
  ['impd’s own origin with no fetch site', { origin: 'http://imp:7070' }, true],
  ['a same-site page', { 'sec-fetch-site': 'same-site' }, false],
  ['a navigation the user typed', { 'sec-fetch-site': 'none' }, false],
  ['an imp’s port with no fetch site', { origin: 'http://imp:20001' }, false],
  ['the null origin', { origin: 'null' }, false],
])('it answers the browser same-origin policy for %s with %p', (_kind, headers, expected) => {
  const request = new Request('http://imp:7070/mcp', {
    method: 'POST',
    headers: { host: 'imp:7070', ...headers },
  });

  expect(isAllowedOrigin(request, { kind: 'browser-same-origin' })).toBe(expected);
});

test.each([
  ['a client that is no browser', {}, true],
  [
    'a browser on impd’s own origin',
    { origin: 'http://imp:7070', 'sec-fetch-site': 'same-origin' },
    true,
  ],
  ['a navigation the user typed', { 'sec-fetch-site': 'none' }, true],
  ['impd’s own origin with no fetch site', { origin: 'http://IMP:7070' }, true],
  [
    'an imp’s page with fetch metadata',
    { origin: 'http://imp:20000', 'sec-fetch-site': 'same-site' },
    false,
  ],
  ['an imp’s page without fetch metadata', { origin: 'http://imp:20000' }, false],
  [
    'a same-origin fetch from an imp’s port',
    { origin: 'http://imp:20000', 'sec-fetch-site': 'same-origin' },
    false,
  ],
  ['the null origin', { origin: 'null' }, false],
  ['a page on another site', { 'sec-fetch-site': 'cross-site' }, false],
  ['an origin that is no URL', { origin: 'http://[imp' }, false],
])('it answers the ambient policy for %s with %p', (_kind, headers, expected) => {
  const request = new Request('http://imp:7070/rpc/system/info', {
    headers: { host: 'imp:7070', ...headers },
  });

  expect(isAllowedOrigin(request, { kind: 'ambient' })).toBe(expected);
});

test.each([
  ['the route’s own origin', { origin: 'https://imp.example.test' }, true],
  [
    'the null origin from a same-origin page',
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    true,
  ],
  ['another origin', { origin: 'https://other.example.test' }, false],
  ['no origin', {}, false],
  ['a same-origin fetch with no origin', { 'sec-fetch-site': 'same-origin' }, false],
  ['the null origin with no fetch site', { origin: 'null' }, false],
  ['the null origin from another site', { origin: 'null', 'sec-fetch-site': 'cross-site' }, false],
  ['an origin that differs only in case', { origin: 'https://IMP.example.test' }, false],
  ['an origin with a trailing slash', { origin: 'https://imp.example.test/' }, false],
  ['an empty origin', { origin: '' }, false],
])('it answers the same-origin form policy for %s with %p', (_kind, headers, expected) => {
  const request = new Request('https://imp.example.test/consent', { method: 'POST', headers });

  expect(
    isAllowedOrigin(request, { kind: 'same-origin-form', origin: 'https://imp.example.test' }),
  ).toBe(expected);
});

test.each([
  ['a request that names no page', {}, true],
  [
    'a same-origin fetch',
    { 'sec-fetch-site': 'same-origin', origin: 'https://imp.example.test' },
    true,
  ],
  ['the route’s own origin with no fetch site', { origin: 'https://imp.example.test' }, true],
  ['another site', { 'sec-fetch-site': 'cross-site', origin: 'https://other.example.test' }, false],
  [
    'a same-site page',
    { 'sec-fetch-site': 'same-site', origin: 'https://imp.example.test' },
    false,
  ],
  [
    'a navigation the user typed',
    { 'sec-fetch-site': 'none', origin: 'https://imp.example.test' },
    false,
  ],
  ['a fetch site with no origin', { 'sec-fetch-site': 'same-origin' }, false],
  ['an origin that differs only in case', { origin: 'https://IMP.example.test' }, false],
  ['an origin with a trailing slash', { origin: 'https://imp.example.test/' }, false],
  ['an origin with another port', { origin: 'https://imp.example.test:8443' }, false],
  ['the null origin', { origin: 'null' }, false],
])('it answers the public route policy for %s with %p', (_kind, headers, expected) => {
  const request = new Request('https://imp.example.test/mcp', { headers });

  expect(
    isAllowedOrigin(request, { kind: 'public-route', origin: 'https://imp.example.test' }),
  ).toBe(expected);
});
