import { expect, test } from 'bun:test';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import { listPlaceholderEnv, renderCredential } from './connector-kinds';

test('it renders a bearer credential with its scheme', () => {
  expect(renderCredential(buildMockBrokerRule({ scheme: 'bearer' }), 'tok')).toBe('Bearer tok');
});

test('it renders a basic credential from the user and the value', () => {
  expect(
    renderCredential(buildMockBrokerRule({ scheme: 'basic', user: 'x-access-token' }), 'tok'),
  ).toBe('Basic eC1hY2Nlc3MtdG9rZW46dG9r');
});

test('it renders a basic credential with an empty user when the rule has none', () => {
  expect(renderCredential(buildMockBrokerRule({ scheme: 'basic' }), 'tok')).toBe('Basic OnRvaw==');
});

test('it renders a raw credential as the bare value', () => {
  expect(renderCredential(buildMockBrokerRule({ scheme: 'raw' }), 'sk')).toBe('sk');
});

test('it lists each placeholder variable once across the granted secrets', () => {
  expect(
    listPlaceholderEnv([
      ['GH_TOKEN', 'GITHUB_TOKEN'],
      ['GH_TOKEN', 'GITHUB_TOKEN'],
      [],
      ['ANTHROPIC_API_KEY'],
    ]),
  ).toStrictEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']);
});
