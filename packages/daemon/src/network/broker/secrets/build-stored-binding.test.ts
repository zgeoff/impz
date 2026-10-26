import { expect, test } from 'bun:test';
import { buildStoredBinding } from './build-stored-binding';

test('it expands the github preset into a static secret with git’s Basic rule and gh’s variables', () => {
  expect(buildStoredBinding({ name: 'gh', preset: 'github', value: 'ghp_x' })).toStrictEqual({
    kind: 'static',
    rules: [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    oauth: null,
  });
});

test('it expands the anthropic preset into a static secret with x-api-key and the bare value', () => {
  expect(buildStoredBinding({ name: 'claude', preset: 'anthropic', value: 'sk' })).toStrictEqual({
    kind: 'static',
    rules: [{ host: 'api.anthropic.com', header: 'x-api-key', scheme: 'raw' }],
    env: ['ANTHROPIC_API_KEY'],
    oauth: null,
  });
});

test('it expands the npm preset into a static secret with a bearer token for the registry', () => {
  expect(buildStoredBinding({ name: 'npm', preset: 'npm', value: 'npm_x' })).toStrictEqual({
    kind: 'static',
    rules: [{ host: 'registry.npmjs.org', header: 'authorization', scheme: 'bearer' }],
    env: ['NPM_TOKEN'],
    oauth: null,
  });
});

test.each([
  [
    'github',
    [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    ['GH_TOKEN', 'GITHUB_TOKEN'],
  ],
  [
    'anthropic',
    [{ host: 'api.anthropic.com', header: 'x-api-key', scheme: 'raw' }],
    ['ANTHROPIC_API_KEY'],
  ],
  [
    'npm',
    [{ host: 'registry.npmjs.org', header: 'authorization', scheme: 'bearer' }],
    ['NPM_TOKEN'],
  ],
] as const)('it expands the older kind name %s as the preset of that name', (kind, rules, env) => {
  expect(buildStoredBinding({ name: 'one', kind, value: 'x' })).toStrictEqual({
    kind: 'static',
    rules,
    env,
    oauth: null,
  });
});

test('it takes the older kind name custom as a static secret with no variables', () => {
  expect(
    buildStoredBinding({
      name: 'api',
      kind: 'custom',
      value: 'x',
      rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    }),
  ).toStrictEqual({
    kind: 'static',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    env: [],
    oauth: null,
  });
});

test('it keeps a static secret’s rules and variables', () => {
  expect(
    buildStoredBinding({
      name: 'api',
      kind: 'static',
      value: 'x',
      rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
      env: ['EXAMPLE_TOKEN'],
    }),
  ).toStrictEqual({
    kind: 'static',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    env: ['EXAMPLE_TOKEN'],
    oauth: null,
  });
});

test('it gives a static secret with no variables an empty list', () => {
  expect(
    buildStoredBinding({
      name: 'api',
      kind: 'static',
      value: 'x',
      rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    }).env,
  ).toStrictEqual([]);
});

test('it keeps an oauth secret’s token endpoint', () => {
  expect(
    buildStoredBinding({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh',
      rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      oauth: {
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'fake-client',
        tokenFormat: 'json',
      },
    }),
  ).toStrictEqual({
    kind: 'oauth',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    env: [],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });
});
