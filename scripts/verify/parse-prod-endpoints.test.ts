import { expect, test } from 'bun:test';
import { parseProdEndpoints } from './parse-prod-endpoints.ts';

test('it takes the deployed origin as the mcp endpoint', () => {
  expect(parseProdEndpoints({ IMPZ_VERIFY_PROD_ORIGIN: 'https://imp.example.com' })).toStrictEqual({
    mcp: 'https://imp.example.com',
  });
});

test.each([
  ['is not set', undefined],
  ['is empty', ''],
  ['is plain http', 'http://imp.example.com'],
  ['has a path', 'https://imp.example.com/mcp'],
  ['has a trailing slash', 'https://imp.example.com/'],
  ['is no URL', 'imp.example.com'],
])('it refuses an origin that %s, and names the variable', (_case, origin) => {
  expect(() => parseProdEndpoints({ IMPZ_VERIFY_PROD_ORIGIN: origin })).toThrow(
    expect.objectContaining({
      code: 'environment',
      message: expect.stringContaining('IMPZ_VERIFY_PROD_ORIGIN'),
    }),
  );
});
