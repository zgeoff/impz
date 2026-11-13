import { expect, test } from 'bun:test';
import type { OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { buildMockClientView } from './build-mock-client-view';

test('it builds a client named conn with one https redirect URI', () => {
  expect(buildMockClientView()).toStrictEqual({
    clientID: toTagged<OAuthClientID>('impc_conn'),
    name: 'conn',
    redirectURIs: ['https://client.example/callback'],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockClientView({ name: 'Spaced Orchard' })).toMatchObject({ name: 'Spaced Orchard' });
});
