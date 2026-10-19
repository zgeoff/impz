import { expect, test } from 'bun:test';
import { isSameOriginForm } from './is-same-origin-form';

const ORIGIN = 'https://imp.example.test';

test.each([
  ['the route’s own origin', { origin: ORIGIN }, true],
  [
    'the null origin from a same-origin page',
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    true,
  ],
  ['another origin', { origin: 'https://other.example.test' }, false],
  ['no origin', {}, false],
  ['the null origin with no fetch site', { origin: 'null' }, false],
  ['the null origin from another site', { origin: 'null', 'sec-fetch-site': 'cross-site' }, false],
  ['an origin that differs only in case', { origin: 'https://IMP.example.test' }, false],
  ['an origin with a trailing slash', { origin: `${ORIGIN}/` }, false],
  ['an empty origin', { origin: '' }, false],
])(
  'it takes a consent form only from the route’s own origin, given %s',
  (_kind, headers, expected) => {
    const request = new Request(`${ORIGIN}/consent`, { method: 'POST', headers });

    const isSame = isSameOriginForm(request, ORIGIN);

    expect(isSame).toBe(expected);
  },
);
