import { expect, test } from 'bun:test';
import { SecretAddKindSchema, SecretAddSchema, SecretBindingSchema } from './secret-add-schema';

test('#SecretAddSchema accepts a static secret with its rules and variables', () => {
  const payload = {
    name: 'api',
    kind: 'static',
    value: 'sk-fake-1',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    env: ['EXAMPLE_TOKEN'],
  } as const;

  const result = SecretAddSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SecretAddSchema accepts an oauth secret with its token endpoint', () => {
  const result = SecretAddSchema.safeParse({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: { tokenUrl: 'https://auth.example.com/oauth/token', clientId: 'fake-client' },
  });

  expect(result.data).toStrictEqual({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'form',
    },
  });
});

test('#SecretAddSchema accepts a preset with no rules', () => {
  const payload = { name: 'gh', preset: 'github', value: 'ghp_fake', replace: true } as const;
  const result = SecretAddSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test.each(['github', 'anthropic', 'npm'] as const)(
  '#SecretAddSchema accepts the older kind %s',
  (kind) => {
    const payload = { name: 'one', kind, value: 'fake-value' } as const;
    const result = SecretAddSchema.safeParse(payload);

    expect(result.data).toStrictEqual(payload);
  },
);

test('#SecretAddSchema accepts the older kind custom with its rules', () => {
  const payload = {
    name: 'api',
    kind: 'custom',
    value: 'sk-fake-1',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
  } as const;

  const result = SecretAddSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SecretAddSchema refuses a preset with rules', () => {
  const result = SecretAddSchema.safeParse({
    name: 'gh',
    preset: 'github',
    value: 'ghp_fake',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    code: 'unrecognized_keys',
    keys: ['rules'],
  });
});

test('#SecretAddSchema refuses an older preset kind with rules', () => {
  const result = SecretAddSchema.safeParse({
    name: 'gh',
    kind: 'github',
    value: 'ghp_fake',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    code: 'unrecognized_keys',
    keys: ['rules'],
  });
});

test('#SecretBindingSchema refuses a preset with rules', () => {
  const result = SecretBindingSchema.safeParse({
    preset: 'github',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    code: 'unrecognized_keys',
    keys: ['rules'],
  });
});

test('#SecretBindingSchema refuses a preset with variables', () => {
  const result = SecretBindingSchema.safeParse({ preset: 'npm', env: ['NPM_TOKEN'] });

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    code: 'unrecognized_keys',
    keys: ['env'],
  });
});

test('#SecretBindingSchema refuses a static secret with a token endpoint', () => {
  const result = SecretBindingSchema.safeParse({
    kind: 'static',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    oauth: { tokenUrl: 'https://auth.example.com/oauth/token', clientId: 'fake-client' },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    code: 'unrecognized_keys',
    keys: ['oauth'],
  });
});

test('#SecretBindingSchema refuses a static secret without rules', () => {
  const result = SecretBindingSchema.safeParse({ kind: 'static' });

  expect(result.error?.issues).toPartiallyContain({
    path: ['rules'],
    message: 'needs at least one host',
  });
});

test('#SecretBindingSchema refuses a static secret with an empty rule list', () => {
  const result = SecretBindingSchema.safeParse({ kind: 'static', rules: [] });

  expect(result.error?.issues).toPartiallyContain({
    path: ['rules'],
    message: 'needs at least one host',
  });
});

test('#SecretBindingSchema refuses two rules for one host', () => {
  const result = SecretBindingSchema.safeParse({
    kind: 'static',
    rules: [
      { host: 'api.example.com', header: 'x-token', scheme: 'raw' },
      { host: 'api.example.com', header: 'x-other', scheme: 'raw' },
    ],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['rules'],
    message: 'api.example.com has more than one rule',
  });
});

test('#SecretBindingSchema keeps the upstream of a static secret’s rule', () => {
  const payload = {
    kind: 'static',
    rules: [
      {
        host: 'svc.imp.internal',
        header: 'authorization',
        scheme: 'bearer',
        upstream: 'http://172.17.0.1:18081',
      },
    ],
  } as const;

  const result = SecretBindingSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SecretBindingSchema keeps the upstream of the older kind custom’s rule', () => {
  const payload = {
    kind: 'custom',
    rules: [
      {
        host: 'svc.imp.internal',
        header: 'authorization',
        scheme: 'bearer',
        upstream: 'http://172.17.0.1:18081',
      },
    ],
  } as const;

  const result = SecretBindingSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SecretBindingSchema refuses an upstream on an oauth secret’s rule', () => {
  const result = SecretBindingSchema.safeParse({
    kind: 'oauth',
    rules: [
      {
        host: 'svc.imp.internal',
        header: 'authorization',
        scheme: 'bearer',
        upstream: 'http://172.17.0.1:18081',
      },
    ],
    oauth: { tokenUrl: 'https://auth.example.com/oauth/token', clientId: 'fake-client' },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['rules'],
    message: 'an oauth secret cannot have an upstream; it is for kind static',
  });
});

test('#SecretBindingSchema refuses an oauth secret without its token endpoint', () => {
  const result = SecretBindingSchema.safeParse({
    kind: 'oauth',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['oauth'],
    message: 'needs a token URL and a client id',
  });
});

test('#SecretBindingSchema refuses the older kind custom with variables', () => {
  const result = SecretBindingSchema.safeParse({
    kind: 'custom',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    env: ['EXAMPLE_TOKEN'],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    code: 'unrecognized_keys',
    keys: ['env'],
  });
});

test('#SecretAddSchema reports the field of an oauth secret it refuses', () => {
  const result = SecretAddSchema.safeParse({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'xml',
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['oauth', 'tokenFormat'] });
});

test('#SecretAddKindSchema accepts the two kinds and the older names', () => {
  expect(SecretAddKindSchema.options).toStrictEqual([
    'static',
    'oauth',
    'github',
    'anthropic',
    'npm',
    'custom',
  ]);
});
