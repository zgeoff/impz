import {
  GrantFilterSchema,
  SecretAddKindSchema,
  SecretBindingSchema,
  SecretPresetSchema,
} from '@impz/api';
import type { GrantFilter, Secret, SecretAddKind, SecretBinding, SecretPreset } from '@impz/api';
import { requireFeatures } from '@impz/client';
import { choice, integer } from 'gunshi/combinators';
import type * as z from 'zod';
import { jsonArg, nameArg } from '../args/common-args';
import { defineCommand, defineGroup } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import {
  formatApiCalls,
  formatAudit,
  formatGrants,
  formatOutput,
  formatRefusedRequests,
  formatSecrets,
} from '../output/format-output';
import { buildTokenTerminal, readToken } from '../prompts/read-token';

const secretArg = { type: 'positional', description: 'secret name', required: true } as const;

interface BindingArgs {
  readonly kind?: SecretAddKind | undefined;
  readonly preset?: SecretPreset | undefined;
  readonly hosts?: string | undefined;
  readonly header?: string | undefined;
  readonly scheme?: string | undefined;
  readonly user?: string | undefined;
  readonly upstream?: string | undefined;
  readonly env?: string | undefined;
  readonly tokenUrl?: string | undefined;
  readonly clientId?: string | undefined;
  readonly tokenFormat?: string | undefined;
}

function buildSecretBinding(args: BindingArgs): SecretBinding {
  if ((args.kind === undefined) === (args.preset === undefined)) {
    throw new UsageError('give one of --kind and --preset');
  }

  const rules = buildRuleFlags(args);
  const oauth = buildOAuthFlags(args);
  const env = args.env?.split(',').map((name) => name.trim());

  const parsed = SecretBindingSchema.safeParse({
    ...(args.kind !== undefined && { kind: args.kind }),
    ...(args.preset !== undefined && { preset: args.preset }),
    ...(rules !== undefined && { rules }),
    ...(oauth !== undefined && { oauth }),
    ...(env !== undefined && { env }),
  });

  if (!parsed.success) {
    const named = args.kind === undefined ? `--preset ${args.preset ?? ''}` : `--kind ${args.kind}`;

    throw new UsageError(
      parsed.error.issues.map((issue) => formatBindingIssue(issue, named)).join('; '),
    );
  }

  return parsed.data;
}

function isNewBinding(binding: Readonly<SecretBinding>): boolean {
  return (
    binding.kind === undefined ||
    binding.kind === 'static' ||
    ('env' in binding && binding.env !== undefined)
  );
}

function buildRuleFlags(args: BindingArgs): Record<string, string | undefined>[] | undefined {
  const given = [args.hosts, args.header, args.scheme, args.user, args.upstream];

  if (given.every((arg) => arg === undefined)) {
    return undefined;
  }

  const hosts = args.hosts?.split(',') ?? [];

  if (args.upstream !== undefined && hosts.length !== 1) {
    throw new UsageError('--upstream needs exactly one host in --hosts');
  }

  const header = (args.header ?? 'authorization').toLowerCase();
  const scheme = args.scheme ?? 'bearer';

  return hosts.map((host) => ({
    host: host.trim(),
    header,
    scheme,
    user: args.user,
    upstream: args.upstream,
  }));
}

function buildOAuthFlags(args: BindingArgs): Record<string, string> | undefined {
  if ([args.tokenUrl, args.clientId, args.tokenFormat].every((arg) => arg === undefined)) {
    return undefined;
  }

  return {
    ...(args.tokenUrl !== undefined && { tokenUrl: args.tokenUrl }),
    ...(args.clientId !== undefined && { clientId: args.clientId }),
    ...(args.tokenFormat !== undefined && { tokenFormat: args.tokenFormat }),
  };
}

const FIELD_FLAGS: Readonly<Record<string, string>> = {
  rules: '--hosts',
  oauth: '--token-url and --client-id',
  env: '--env',
  host: '--hosts',
  header: '--header',
  scheme: '--scheme',
  user: '--user',
  upstream: '--upstream',
  tokenUrl: '--token-url',
  clientId: '--client-id',
  tokenFormat: '--token-format',
};

function formatBindingIssue(issue: Readonly<z.core.$ZodIssue>, named: string): string {
  if (issue.code === 'unrecognized_keys') {
    const flags = issue.keys.map((key) => FIELD_FLAGS[key] ?? key);

    return `${named} takes no ${flags.join(', ')}`;
  }

  const field = issue.path.findLast((key) => typeof key === 'string');
  const flag = typeof field === 'string' ? FIELD_FLAGS[field] : undefined;

  return flag === undefined ? issue.message : `${flag}: ${issue.message}`;
}

function formatOAuthOutcome(secret: Readonly<Secret>): string | null {
  const oauth = secret.oauth;

  if (oauth === undefined) {
    return null;
  }

  if (oauth.status === 'ready') {
    const until =
      oauth.expiresAt === null ? '' : `, access token valid until ${oauth.expiresAt.toISOString()}`;

    return `impz: ${secret.name} signed in${until}`;
  }

  const reason = oauth.error === null ? '' : `: ${oauth.error}`;

  return `impz: ${secret.name} is ${oauth.status}${reason}`;
}

function formatRefreshFailure(secret: Readonly<Secret>): string | null {
  const oauth = secret.oauth;

  if (oauth === undefined) {
    return `${secret.name} is not an oauth secret`;
  }

  if (oauth.status === 'ready') {
    return null;
  }

  const reason = oauth.error === null ? '' : `: ${oauth.error}`;

  return `${secret.name} is ${oauth.status}${reason}`;
}

const addCommand = defineCommand({
  name: 'add',
  description: 'Store a secret in impd; the value comes from stdin or a prompt, never a flag',
  args: {
    name: secretArg,
    kind: choice(SecretAddKindSchema.options, {
      description:
        'static or oauth, both with --hosts; github, anthropic, npm and custom are the older names of --preset and static',
    }),
    preset: choice(SecretPresetSchema.options, {
      description: 'github, anthropic or npm: a static secret with its hosts and variables',
    }),

    // not --host, which names the impd to call
    hosts: {
      type: 'string',
      description: 'static, oauth: the hosts it is for, comma-separated',
    },
    header: {
      type: 'string',
      description: 'static, oauth: the header to set (default authorization)',
    },
    scheme: { type: 'string', description: 'static, oauth: bearer (default), basic or raw' },
    user: { type: 'string', description: 'static, oauth: the user name for basic' },
    upstream: {
      type: 'string',
      description:
        'static, one host: send its requests here (http or https origin) instead of the host; the credential goes there',
    },
    env: {
      type: 'string',
      description:
        'static, oauth: the variables a granted imp gets set to a placeholder, comma-separated',
    },
    'token-url': { type: 'string', description: 'oauth: the https token endpoint' },
    'client-id': { type: 'string', description: 'oauth: the client the refresh token is for' },
    'token-format': {
      type: 'string',
      description: 'oauth: form (default) or json, the token request body',
    },
    replace: { type: 'boolean', description: 'replace the value of a secret by that name' },
    rebind: {
      type: 'boolean',
      description: 'with --replace: let the kind or hosts change, and revoke it from every imp',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const binding = buildSecretBinding({
        ...ctx.values,
        tokenUrl: ctx.values['token-url'],
        clientId: ctx.values['client-id'],
        tokenFormat: ctx.values['token-format'],
      });

      const isOAuth = binding.kind === 'oauth';

      if (ctx.values.rebind === true && ctx.values.replace !== true) {
        throw new UsageError('--rebind needs --replace');
      }

      // an older impd would take another binding and keep every grant; drop
      // the upstream unread and send the credential to the host; refuse the
      // oauth kind, or drop its config unread; or drop the variables unread
      await requireFeatures(client, {
        ...(ctx.values.replace === true && {
          secretRebind: 'let --replace change the hosts and keep every grant',
        }),
        ...(ctx.values.upstream !== undefined && {
          secretUpstream: 'send the credential to the host itself',
        }),
        ...(isOAuth && { oauthSecrets: 'refuse the oauth kind' }),
        ...(isNewBinding(binding) && {
          secretPresets: 'refuse a preset or a static secret, and drop --env unread',
        }),
      });

      const prompt = isOAuth ? 'refresh token' : 'value';

      const value = await readToken(
        `${prompt} for ${ctx.values.name}: `,
        buildTokenTerminal(ctx.extensions.impz.io),
      );

      if (value === '') {
        throw new UsageError('no value given; nothing stored');
      }

      const secret = await client.secrets.add({
        ...binding,
        name: ctx.values.name,
        value,
        ...(ctx.values.replace === true && { replace: true }),
        ...(ctx.values.rebind === true && { rebind: true }),
      });

      if (secret.droppedGrants > 0) {
        ctx.extensions.impz.io.printError(
          `impz: ${secret.name} rebound; revoked from ${String(secret.droppedGrants)} imp(s)`,
        );
      }

      const outcome = formatOAuthOutcome(secret);

      if (outcome !== null) {
        ctx.extensions.impz.io.printError(outcome);
      }

      ctx.extensions.impz.io.print(
        formatOutput(secret, ctx.values.json, (one) => formatSecrets([one])),
      );
    }),
});

const refreshCommand = defineCommand({
  name: 'refresh',
  description: 'Refresh an oauth secret now; exits 1 unless it is ready after it',
  args: { name: secretArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await requireFeatures(client, { oauthSecrets: 'not know the command' });

      const secret = await client.secrets.refresh({ name: ctx.values.name });

      ctx.extensions.impz.io.print(
        formatOutput(secret, ctx.values.json, (one) => formatSecrets([one])),
      );

      const failure = formatRefreshFailure(secret);

      if (failure !== null) {
        throw new Error(failure);
      }
    }),
});

const lsCommand = defineCommand({
  name: 'ls',
  description: 'List secrets: their hosts and the imps they are granted to',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const secrets = await client.secrets.list();

      ctx.extensions.impz.io.print(formatOutput(secrets, ctx.values.json, formatSecrets));
    }),
});

const rmCommand = defineCommand({
  name: 'rm',
  description: 'Delete a secret and revoke it from every imp',
  args: { name: secretArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.secrets.delete({ name: ctx.values.name });
    }),
});

export const secretCommand = defineGroup({
  name: 'secret',
  description: 'Manage the secrets the credential broker adds',
  subCommands: { add: addCommand, refresh: refreshCommand, ls: lsCommand, rm: rmCommand },
});

export const grantCommand = defineCommand({
  name: 'grant',
  description: "Let an imp use a secret: the broker adds it to the imp's requests to its hosts",
  args: {
    name: nameArg,
    secret: secretArg,
    methods: {
      type: 'string',
      description:
        'only requests with one of these methods get the secret, comma-separated (GET,HEAD)',
    },
    paths: {
      type: 'string',
      description:
        'only requests to one of these paths get it, comma-separated; * is one segment, a last /** the rest',
    },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const filter = buildGrantFilter(ctx.values);

      // an older impd drops the filter unread and would grant the whole host
      if (filter !== undefined) {
        await requireFeatures(client, { grantFilters: 'grant the whole host' });
      }

      await client.grants.add({
        name: ctx.values.name,
        secret: ctx.values.secret,
        ...(filter !== undefined && { filter }),
      });
    }),
});

interface GrantFilterArgs {
  readonly methods?: string | undefined;
  readonly paths?: string | undefined;
}

function buildGrantFilter(args: GrantFilterArgs): GrantFilter | undefined {
  if (args.methods === undefined && args.paths === undefined) {
    return undefined;
  }

  const result = GrantFilterSchema.safeParse({
    ...(args.methods !== undefined && { methods: args.methods.split(',') }),
    ...(args.paths !== undefined && { paths: args.paths.split(',') }),
  });

  if (!result.success) {
    const [issue] = result.error.issues;
    const flag = issue?.path[0] === 'methods' ? '--methods' : '--paths';

    throw new UsageError(`${flag}: ${issue?.message ?? 'not a filter'}`);
  }

  return result.data;
}

export const revokeCommand = defineCommand({
  name: 'revoke',
  description: 'Take a secret away from an imp',
  args: { name: nameArg, secret: secretArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.grants.delete({ name: ctx.values.name, secret: ctx.values.secret });
    }),
});

export const grantsCommand = defineCommand({
  name: 'grants',
  description: 'List the secrets granted to an imp',
  args: {
    name: nameArg,
    json: jsonArg,
    filters: { type: 'boolean', description: 'show the methods and paths each grant covers' },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      if (ctx.values.filters === true) {
        await requireFeatures(client, { grantFilters: 'not know the call' });

        const grants = await client.grants.details({ name: ctx.values.name });

        ctx.extensions.impz.io.print(formatOutput(grants, ctx.values.json, formatGrants));

        return;
      }

      const names = await client.grants.list({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(names, ctx.values.json, (list) => list.join('\n')));
    }),
});

export const auditCommand = defineCommand({
  name: 'audit',
  description:
    'Show requests the broker sent with a credential or refused, or calls to impd, newest first',
  args: {
    name: { type: 'positional', description: 'imp name (default: every imp)', required: false },
    kind: choice(['broker', 'refused', 'api'] as const, {
      description:
        'broker: requests with a credential (default); refused: requests the broker refused; api: calls that changed impd',
    }),
    limit: integer({ min: 1, max: 1000, description: 'how many rows (default 100, at most 1000)' }),
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const limit = ctx.values.limit;
      const kind = ctx.values.kind ?? 'broker';

      const input = {
        ...(ctx.values.name !== undefined && { name: ctx.values.name }),
        ...(limit !== undefined && { limit }),
      };

      if (kind === 'api') {
        const calls = await client.audit.calls(input);

        ctx.extensions.impz.io.print(formatOutput(calls, ctx.values.json, formatApiCalls));

        return;
      }

      if (kind === 'refused') {
        await requireFeatures(client, { brokerRefusals: 'not know the call' });

        const refused = await client.audit.refused(input);

        ctx.extensions.impz.io.print(formatOutput(refused, ctx.values.json, formatRefusedRequests));

        return;
      }

      const entries = await client.audit.list(input);

      ctx.extensions.impz.io.print(formatOutput(entries, ctx.values.json, formatAudit));
    }),
});
