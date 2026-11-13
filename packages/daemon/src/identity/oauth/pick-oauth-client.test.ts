import { expect, test } from 'bun:test';
import type { OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { buildMockClientView } from '../../test-utils/identity/build-mock-client-view';
import { pickOAuthClient } from './pick-oauth-client';

test('#pickOAuthClient picks the client whose client ID is the reference', () => {
  const spaced = buildMockClientView({
    clientID: toTagged<OAuthClientID>('impc_one'),
    name: 'Spaced Orchard',
  });

  const other = buildMockClientView({
    clientID: toTagged<OAuthClientID>('impc_two'),
    name: 'other',
  });

  expect(pickOAuthClient('impc_one', [spaced, other], [])).toStrictEqual({
    kind: 'found',
    client: spaced,
  });
});

test('#pickOAuthClient picks the one client whose name matches', () => {
  const conn = buildMockClientView({ name: 'conn' });

  expect(pickOAuthClient('conn', [conn], [conn])).toStrictEqual({ kind: 'found', client: conn });
});

test('#pickOAuthClient finds no client when neither an ID nor a name matches', () => {
  const conn = buildMockClientView({ name: 'conn' });

  expect(pickOAuthClient('gone', [conn], [])).toStrictEqual({ kind: 'missing' });
});

test('#pickOAuthClient picks no client when the name matches two, and gives both client IDs', () => {
  const tabbed = buildMockClientView({
    clientID: toTagged<OAuthClientID>('impc_one'),
    name: '  Spaced\tOrchard  ',
  });

  const spaced = buildMockClientView({
    clientID: toTagged<OAuthClientID>('impc_two'),
    name: 'Spaced Orchard',
  });

  expect(pickOAuthClient('Spaced Orchard', [tabbed, spaced], [tabbed, spaced])).toStrictEqual({
    kind: 'ambiguous',
    clientIDs: [toTagged<OAuthClientID>('impc_one'), toTagged<OAuthClientID>('impc_two')],
  });
});
