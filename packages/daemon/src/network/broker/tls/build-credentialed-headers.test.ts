import { expect, test } from 'bun:test';
import { buildMockCredential } from '../../../test-utils/network/build-mock-credential';
import { buildCredentialedHeaders } from './build-credentialed-headers';

function setupTest() {
  return {
    credential: buildMockCredential({ header: 'authorization', value: 'Bearer real' }),
  };
}

test.each(['Imp-Identity', 'IMP-IDENTITY', 'imp_identity', 'Imp_Identity', 'imp-IDENTITY'])(
  'it removes the guest’s %s header and sets the token',
  (name) => {
    const ctx = setupTest();

    const headers = buildCredentialedHeaders(
      new Headers({ [name]: 'forged' }),
      ctx.credential,
      't',
    );

    expect(Object.fromEntries(headers)).toStrictEqual({
      authorization: 'Bearer real',
      'imp-identity': 't',
    });
  },
);

test('it removes a header that the guest repeated', () => {
  const ctx = setupTest();

  const source = new Headers();

  source.append('imp-identity', 'forged-1');
  source.append('Imp-Identity', 'forged-2');
  source.append('imp_identity', 'forged-3');

  const headers = buildCredentialedHeaders(source, ctx.credential, 't');

  expect([...headers]).toStrictEqual([
    ['authorization', 'Bearer real'],
    ['imp-identity', 't'],
  ]);
});

test('it removes the guest’s copy and sets the token when Connection names the header', () => {
  const ctx = setupTest();

  const headers = buildCredentialedHeaders(
    new Headers({ connection: 'keep-alive, imp-identity', 'imp-identity': 'forged' }),
    ctx.credential,
    't',
  );

  expect(Object.fromEntries(headers)).toStrictEqual({
    authorization: 'Bearer real',
    'imp-identity': 't',
  });
});

test('it removes the guest’s copy and adds none when the rule has no token', () => {
  const ctx = setupTest();

  const headers = buildCredentialedHeaders(
    new Headers({ 'imp-identity': 'forged', 'x-keep': '1' }),
    ctx.credential,
    null,
  );

  expect(Object.fromEntries(headers)).toStrictEqual({
    authorization: 'Bearer real',
    'x-keep': '1',
  });
});

test('it keeps the headers it has no rule for', () => {
  const ctx = setupTest();

  const headers = buildCredentialedHeaders(
    new Headers({ 'x-identity': 'kept', 'imp-identity-extra': 'kept' }),
    ctx.credential,
    't',
  );

  expect(Object.fromEntries(headers)).toStrictEqual({
    authorization: 'Bearer real',
    'imp-identity': 't',
    'x-identity': 'kept',
    'imp-identity-extra': 'kept',
  });
});

test('it sets the credential over a guest header of the same name', () => {
  const ctx = setupTest();

  const headers = buildCredentialedHeaders(
    new Headers({ authorization: 'Bearer imp-broker-placeholder' }),
    ctx.credential,
    null,
  );

  expect(headers.get('authorization')).toBe('Bearer real');
});
