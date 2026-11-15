import { expect, test } from 'bun:test';
import { buildMCPConfig } from './build-mcp-config.ts';

test('it signs in to the route at the origin, and sends the credentials only to that issuer', () => {
  const config = buildMCPConfig('https://imp.example.com', {
    name: 'reader',
    secretEnv: 'READER_SECRET',
    scope: 'read',
  });

  expect(config).toStrictEqual({
    servers: {
      impz: {
        transport: 'http',
        url: 'https://imp.example.com/mcp',
        auth: {
          clientCredentials: {
            clientID: 'service:reader',
            secretEnv: 'READER_SECRET',
            scope: 'read',
            issuer: 'https://imp.example.com',
          },
        },
        readTools: [
          'imp_list',
          'imp_image_list',
          'imp_event_list',
          'imp_checkpoint_list',
          'imp_url',
        ],
      },
    },
  });
});
