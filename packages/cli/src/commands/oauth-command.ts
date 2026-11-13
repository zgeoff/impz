import { RedirectUriSchema } from '@impz/api';
import { jsonArg } from '../args/common-args';
import { defineCommand, defineGroup } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import {
  formatOAuthClients,
  formatOAuthEnrollment,
  formatOAuthGrants,
  formatOAuthPasskeys,
  formatOutput,
} from '../output/format-output';

const clientArg = { type: 'positional', description: 'client name', required: true } as const;

const redirectArg = {
  type: 'string',
  description: "the client's redirect URIs, matched exactly (comma-separated)",
  required: true,
} as const;

const clientAddCommand = defineCommand({
  name: 'add',
  description: "Add a client; its client ID prints on stdout, for the connector's settings",
  args: { name: clientArg, 'redirect-uri': redirectArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const redirectUris = parseRedirectUris(ctx.values['redirect-uri']);

      const added = await client.oauth.clients.add({ name: ctx.values.name, redirectUris });

      ctx.extensions.impz.io.print(formatOutput(added, ctx.values.json, (made) => made.clientId));
    }),
});

const clientSetCommand = defineCommand({
  name: 'set',
  description: "Replace a client's redirect URIs; its client ID and grants stay",
  args: { name: clientArg, 'redirect-uri': redirectArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const redirectUris = parseRedirectUris(ctx.values['redirect-uri']);

      const updated = await client.oauth.clients.update({ name: ctx.values.name, redirectUris });

      ctx.extensions.impz.io.print(formatOutput([updated], ctx.values.json, formatOAuthClients));
    }),
});

const clientLsCommand = defineCommand({
  name: 'ls',
  description: 'List clients, their client IDs and redirect URIs',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const clients = await client.oauth.clients.list();

      ctx.extensions.impz.io.print(formatOutput(clients, ctx.values.json, formatOAuthClients));
    }),
});

const clientRmCommand = defineCommand({
  name: 'rm',
  description: 'Remove a client; its grants end, and their sessions and commands with them',
  args: { name: clientArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.oauth.clients.delete({ name: ctx.values.name });
    }),
});

const clientCommand = defineGroup({
  name: 'client',
  description: 'Add, list, change or remove the clients that may sign in',
  subCommands: {
    add: clientAddCommand,
    set: clientSetCommand,
    ls: clientLsCommand,
    rm: clientRmCommand,
  },
});

const grantLsCommand = defineCommand({
  name: 'ls',
  description: 'List grants: their client, what approved them, and their scope',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const grants = await client.oauth.grants.list();

      ctx.extensions.impz.io.print(formatOutput(grants, ctx.values.json, formatOAuthGrants));
    }),
});

const grantRmCommand = defineCommand({
  name: 'rm',
  description: 'End a grant; its tokens, sessions and running commands end at once',
  args: {
    id: { type: 'positional', description: 'grant ID (impz oauth grant ls)', required: true },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.oauth.grants.delete({ id: ctx.values.id });
    }),
});

const grantCommand = defineGroup({
  name: 'grant',
  description: 'List or end the grants sign-ins made',
  subCommands: { ls: grantLsCommand, rm: grantRmCommand },
});

const passkeyEnrollCommand = defineCommand({
  name: 'enroll',
  description:
    'Make a one-time enrollment token; open the page it names and enter the token to enroll a passkey',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const enrollment = await client.oauth.passkeys.enroll();

      ctx.extensions.impz.io.print(
        formatOutput(enrollment, ctx.values.json, formatOAuthEnrollment),
      );
    }),
});

const passkeyLsCommand = defineCommand({
  name: 'ls',
  description: "List the owner's passkeys, which approve each sign-in",
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const passkeys = await client.oauth.passkeys.list();

      ctx.extensions.impz.io.print(formatOutput(passkeys, ctx.values.json, formatOAuthPasskeys));
    }),
});

const passkeyRmCommand = defineCommand({
  name: 'rm',
  description: 'Remove a passkey; it signs in no more',
  args: {
    id: { type: 'positional', description: 'passkey ID (impz oauth passkey ls)', required: true },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.oauth.passkeys.delete({ id: ctx.values.id });
    }),
});

const passkeyResetCommand = defineCommand({
  name: 'reset',
  description: 'Remove every passkey, and end each sign-in in progress; grants stay',
  args: {},
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.oauth.passkeys.reset();
    }),
});

const passkeyCommand = defineGroup({
  name: 'passkey',
  description: "Enroll, list or remove the owner's passkeys, which approve each sign-in",
  subCommands: {
    enroll: passkeyEnrollCommand,
    ls: passkeyLsCommand,
    rm: passkeyRmCommand,
    reset: passkeyResetCommand,
  },
});

export const oauthCommand = defineGroup({
  name: 'oauth',
  description: 'Manage sign-ins to the public MCP route: clients, grants and passkeys',
  subCommands: { client: clientCommand, grant: grantCommand, passkey: passkeyCommand },
});

function parseRedirectUris(text: string): string[] {
  const uris = text
    .split(',')
    .map((uri) => uri.trim())
    .filter((uri) => uri !== '');

  const bad = uris.find((uri) => !RedirectUriSchema.safeParse(uri).success);

  if (uris.length === 0 || bad !== undefined) {
    throw new UsageError(
      `--redirect-uri takes https URLs, or http on a loopback host, with no fragment; not ${bad ?? text}`,
    );
  }

  return uris;
}
