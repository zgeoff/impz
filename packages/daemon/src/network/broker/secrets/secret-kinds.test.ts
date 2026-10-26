import { expect, test } from 'bun:test';
import { SECRET_KINDS } from './secret-kinds';

test('it writes a static secret’s value file as the bare value', () => {
  expect(SECRET_KINDS.static.formatValueFile('sk-fake')).toBe('sk-fake');
});

test('it sends a static secret’s value file as the credential', () => {
  expect(SECRET_KINDS.static.findCredential('sk-fake')).toStrictEqual({
    value: 'sk-fake',
    oauth: null,
  });
});

test('it writes an oauth secret’s value file as a pending state with the refresh token', () => {
  expect(JSON.parse(SECRET_KINDS.oauth.formatValueFile('fake-refresh'))).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: 'fake-refresh',
    accessToken: null,
    idToken: null,
    expiresAt: null,
    refreshedAt: null,
    status: 'pending',
    error: null,
  });
});

test('it sends an oauth secret’s access token, with when it was refreshed', () => {
  const content = JSON.stringify({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: 'fake-refresh',
    accessToken: 'fake-access',
    idToken: null,
    expiresAt: 2000,
    refreshedAt: 1000,
    status: 'ready',
    error: null,
  });

  expect(SECRET_KINDS.oauth.findCredential(content)).toStrictEqual({
    value: 'fake-access',
    oauth: { refreshedAt: 1000 },
  });
});

test('it sends no credential for an oauth secret with no access token yet', () => {
  expect(
    SECRET_KINDS.oauth.findCredential(SECRET_KINDS.oauth.formatValueFile('fake-refresh')),
  ).toBeNull();
});

test('it sends no credential for an oauth value file it cannot read', () => {
  expect(SECRET_KINDS.oauth.findCredential('not json')).toBeNull();
});

test('it refreshes an oauth secret', () => {
  expect(SECRET_KINDS.oauth.isRefreshed).toBeTrue();
});

test('it never refreshes a static secret', () => {
  expect(SECRET_KINDS.static.isRefreshed).toBeFalse();
});
