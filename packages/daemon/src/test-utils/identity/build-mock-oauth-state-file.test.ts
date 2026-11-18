import { expect, test } from 'bun:test';
import { buildMockOAuthStateFile } from './build-mock-oauth-state-file';

test('it builds a default oauth state file', () => {
  const state = buildMockOAuthStateFile();
  const received: unknown = state;

  expect(received).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: expect.stringMatching(/^fake-refresh-[A-Za-z0-9]{12}$/u),
    accessToken: expect.stringMatching(/^fake-access-[A-Za-z0-9]{12}$/u),
    idToken: expect.stringMatching(/^fake-id-[A-Za-z0-9]{12}$/u),
    expiresAt: (state.refreshedAt ?? 0) + 240 * 3_600_000,
    refreshedAt: expect.any(Number),
    status: 'ready',
    error: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const state: unknown = buildMockOAuthStateFile({
    refreshToken: 'fake-refresh-0',
    expiresAt: null,
    status: 'needs_login',
    error: 'invalid_grant',
  });

  expect(state).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: 'fake-refresh-0',
    accessToken: expect.stringMatching(/^fake-access-/u),
    idToken: expect.stringMatching(/^fake-id-/u),
    expiresAt: null,
    refreshedAt: expect.any(Number),
    status: 'needs_login',
    error: 'invalid_grant',
  });
});
