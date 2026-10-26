import { expect, test } from 'bun:test';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import {
  SecretRulesError,
  listPlaceholderEnv,
  renderCredential,
  resolveBinding,
} from './connector-kinds';

test('it gives the github preset Basic for git, a bearer token for the APIs and the gh variables', () => {
  expect(resolveBinding('github', undefined)).toStrictEqual({
    rules: [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
  });
});

test('it gives the anthropic preset x-api-key with the bare value', () => {
  expect(resolveBinding('anthropic', undefined)).toStrictEqual({
    rules: [{ host: 'api.anthropic.com', header: 'x-api-key', scheme: 'raw' }],
    env: ['ANTHROPIC_API_KEY'],
  });
});

test('it gives the npm preset a bearer token for the registry', () => {
  expect(resolveBinding('npm', undefined)).toStrictEqual({
    rules: [{ host: 'registry.npmjs.org', header: 'authorization', scheme: 'bearer' }],
    env: ['NPM_TOKEN'],
  });
});

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

test('it takes the rules of a custom secret from the caller, with no variables', () => {
  expect(
    resolveBinding('custom', [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }]),
  ).toStrictEqual({
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    env: [],
  });
});

test('it takes the rules of an oauth secret from the caller, with no variables', () => {
  expect(
    resolveBinding('oauth', [
      { host: 'api.example.com', header: 'authorization', scheme: 'bearer' },
    ]),
  ).toStrictEqual({
    rules: [{ host: 'api.example.com', header: 'authorization', scheme: 'bearer' }],
    env: [],
  });
});

test('it keeps the upstream of a custom secret’s rule', () => {
  expect(
    resolveBinding('custom', [
      {
        host: 'svc.imp.internal',
        header: 'authorization',
        scheme: 'bearer',
        upstream: 'http://172.17.0.1:18081',
      },
    ]).rules,
  ).toStrictEqual([
    {
      host: 'svc.imp.internal',
      header: 'authorization',
      scheme: 'bearer',
      upstream: 'http://172.17.0.1:18081',
    },
  ]);
});

test.each([['custom'], ['oauth']] as const)('it refuses kind %s without rules', (kind) => {
  expect(() => resolveBinding(kind, undefined)).toThrowWithMessage(
    SecretRulesError,
    `kind ${kind} needs at least one host`,
  );
});

test.each([['custom'], ['oauth']] as const)(
  'it refuses kind %s with an empty rule list',
  (kind) => {
    expect(() => resolveBinding(kind, [])).toThrowWithMessage(
      SecretRulesError,
      `kind ${kind} needs at least one host`,
    );
  },
);

test('it refuses two rules for one host', () => {
  expect(() =>
    resolveBinding('custom', [
      { host: 'api.example.com', header: 'x-token', scheme: 'raw' },
      { host: 'api.example.com', header: 'x-other', scheme: 'raw' },
    ]),
  ).toThrowWithMessage(SecretRulesError, 'api.example.com has more than one rule');
});

test('it refuses rules for a preset kind', () => {
  expect(() =>
    resolveBinding('github', [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }]),
  ).toThrowWithMessage(
    SecretRulesError,
    'kind github has its own hosts; rules are for kinds custom and oauth',
  );
});

test('it refuses an upstream on an oauth secret’s rule', () => {
  expect(() =>
    resolveBinding('oauth', [
      {
        host: 'svc.imp.internal',
        header: 'authorization',
        scheme: 'bearer',
        upstream: 'http://172.17.0.1:18081',
      },
    ]),
  ).toThrowWithMessage(
    SecretRulesError,
    'kind oauth cannot have an upstream; it is for kind custom',
  );
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
