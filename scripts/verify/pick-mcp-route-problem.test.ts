import { expect, test } from 'bun:test';
import { pickMCPRouteProblem } from './pick-mcp-route-problem.ts';

test('it finds no problem on a route that asks for a token and offers client_credentials', () => {
  expect(
    pickMCPRouteProblem({
      status: 401,
      challenge: 'Bearer resource_metadata="https://imp.example.com/.well-known/x"',
      grants: ['authorization_code', 'client_credentials'],
    }),
  ).toBeNull();
});

test.each([
  [200, 'Bearer resource_metadata="https://imp.example.com/.well-known/x"'],
  [401, 'Bearer'],
])('it names the status when /mcp answers %d with %s', (status, challenge) => {
  expect(pickMCPRouteProblem({ status, challenge, grants: ['client_credentials'] })).toStartWith(
    `/mcp answered ${String(status)}`,
  );
});

test('it names the missing grant when the authorization server offers no client_credentials', () => {
  expect(
    pickMCPRouteProblem({
      status: 401,
      challenge: 'Bearer resource_metadata="https://imp.example.com/.well-known/x"',
      grants: ['authorization_code', 'refresh_token'],
    }),
  ).toStartWith(
    'the authorization server offers authorization_code, refresh_token and no client_credentials grant',
  );
});
