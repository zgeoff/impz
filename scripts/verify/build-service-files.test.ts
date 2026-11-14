import { expect, test } from 'bun:test';
import { buildServiceFiles } from './build-service-files.ts';

test('it gives the run client every scope on the resource, and only the wv-mcp- imps', () => {
  const digest = 'ab'.repeat(32);

  expect(buildServiceFiles('http://127.0.0.1:7571/mcp', digest)).toStrictEqual({
    tokens: {
      resource: 'http://127.0.0.1:7571/mcp',
      clients: {
        'wringer-verify': { scopes: ['read', 'exec', 'manage'], secretDigests: [digest] },
      },
    },
    clients: { clients: { 'wringer-verify': { imps: ['wv-mcp-*'] } } },
  });
});
