import type { ClientView, OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';

export function buildMockClientView(overrides: Partial<ClientView> = {}): ClientView {
  return {
    clientID: toTagged<OAuthClientID>('impc_conn'),
    name: 'conn',
    redirectURIs: ['https://client.example/callback'],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
