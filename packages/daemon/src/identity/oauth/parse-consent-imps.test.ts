import { expect, test } from 'bun:test';
import { parseConsentImps } from './parse-consent-imps';

test.each([
  ['dev-*', ['dev-*']],
  ['dev-* web', ['dev-*', 'web']],
  [' dev-*,web ,, api ', ['dev-*', 'web', 'api']],
  ['web web', ['web']],
  ['*', ['*']],
])('#parseConsentImps reads %p as the patterns %p, with no grant of secrets', (text, imps) => {
  expect(parseConsentImps(new URLSearchParams({ imps: text }))).toStrictEqual({
    ok: true,
    limits: { imps, grantable: false },
  });
});

test.each([[''], ['  '], [' , ']])('#parseConsentImps refuses %p, which names no imp', (text) => {
  expect(parseConsentImps(new URLSearchParams({ imps: text }))).toStrictEqual({
    ok: false,
    error: 'Name at least one imp, or * for every imp.',
  });
});

test('#parseConsentImps refuses a form with no imps field', () => {
  expect(parseConsentImps(new URLSearchParams())).toMatchObject({ ok: false });
});

test.each([['Dev'], ['*dev'], ['d*v'], ['dev-1 1web']])(
  '#parseConsentImps refuses %p, which holds no imp pattern',
  (text) => {
    expect(parseConsentImps(new URLSearchParams({ imps: text }))).toStrictEqual({
      ok: false,
      error: 'Each pattern must be an imp name, or a name prefix and a trailing *, such as dev-*.',
    });
  },
);

test('#parseConsentImps refuses more than 32 patterns', () => {
  const text = Array.from({ length: 33 }, (_, index) => `imp-${String(index)}`).join(' ');

  expect(parseConsentImps(new URLSearchParams({ imps: text }))).toStrictEqual({
    ok: false,
    error: 'Name at most 32 imp patterns.',
  });
});
