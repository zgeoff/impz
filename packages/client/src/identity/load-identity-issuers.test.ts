import { expect, test } from 'bun:test';
import { buildStubIdentityKey } from '../test-utils/build-stub-identity-token';
import { loadIdentityIssuers } from './load-identity-issuers';

function setupTest() {
  const key = buildStubIdentityKey('key-a');

  return { document: { issuer: 'host-a', keys: [key.jwk], retire: [] } };
}

test('it loads a document as printed', () => {
  const ctx = setupTest();

  expect(loadIdentityIssuers([ctx.document])).toStrictEqual([ctx.document]);
});

test('it refuses two documents with one issuer', () => {
  const ctx = setupTest();

  expect(() => loadIdentityIssuers([ctx.document, ctx.document])).toThrowWithMessage(
    Error,
    'two identity key documents name the issuer host-a',
  );
});

test('it refuses no document', () => {
  expect(() => loadIdentityIssuers([])).toThrowWithMessage(
    Error,
    'no identity key document is configured',
  );
});

test('it refuses a document that is not a key set', () => {
  expect(() => loadIdentityIssuers([{ issuer: 'host-a' }])).toThrow();
});
