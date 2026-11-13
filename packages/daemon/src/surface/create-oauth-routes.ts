import type { OAuthClient, OAuthGrant } from '@impz/api';
import { MCPAuthError } from '@zgeoff/mcp-auth';
import type { ClientView, GrantID, GrantView, MCPAuthAdmin, PasskeyID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { match } from 'ts-pattern';
import type { TokenStore } from '../identity/auth/token-store';
import { pickGrantScope } from '../identity/oauth/grant-limits';
import { pickOAuthClient } from '../identity/oauth/pick-oauth-client';
import { ImpdError } from '../platform/errors/impd-error';
import { buildConflictError, buildNotFoundError } from '../platform/errors/impd-errors';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createOAuthRoutes(os: RpcImplementer, deps: RouterDeps) {
  const admin = deps.oauth.admin;
  const server = deps.oauth.server;

  return {
    clients: {
      list: os.oauth.clients.list.handler(async () => {
        const clients = await admin.clients.list();

        return clients.map((client) => toOAuthClient(client));
      }),
      add: os.oauth.clients.add.handler((context) =>
        withClientErrors(context.input.name, async () => {
          const added = await admin.clients.add(context.input.name, context.input.redirectUris);

          return toOAuthClient(added);
        }),
      ),
      update: os.oauth.clients.update.handler((context) =>
        withClientErrors(context.input.client, async () => {
          const target = await resolveClient(admin, context.input.client);
          const updated = await admin.clients.update(target.clientID, context.input.redirectUris);

          return toOAuthClient(updated);
        }),
      ),
      delete: os.oauth.clients.delete.handler((context) =>
        withClientErrors(context.input.client, async () => {
          const target = await resolveClient(admin, context.input.client);

          await admin.clients.remove(target.clientID);

          return {};
        }),
      ),
    },
    grants: {
      list: os.oauth.grants.list.handler(async () => {
        const grants = await admin.grants.list();

        return grants.map((grant) => toOAuthGrant(grant, deps.tokens));
      }),
      delete: os.oauth.grants.delete.handler(async (context) => {
        const isRevoked = await admin.grants.revoke(toTagged<GrantID>(context.input.id));

        if (!isRevoked) {
          throw buildNotFoundError('oauth-grant', context.input.id);
        }

        return {};
      }),
    },
    passkeys: {
      list: os.oauth.passkeys.list.handler(async () => {
        const passkeys = await admin.passkeys.list();

        return passkeys.map((passkey) => ({
          id: passkey.id,
          createdAt: new Date(passkey.createdAt),
          lastUsedAt: passkey.lastUsedAt === null ? null : new Date(passkey.lastUsedAt),
        }));
      }),
      enroll: os.oauth.passkeys.enroll.handler(async () => ({
        token: await admin.passkeys.createEnrollmentToken(),
        url: server === null ? null : `${server.issuer}${server.paths.browser.enroll}`,
      })),
      delete: os.oauth.passkeys.delete.handler(async (context) => {
        await admin.passkeys.remove(toTagged<PasskeyID>(context.input.id));

        return {};
      }),
      reset: os.oauth.passkeys.reset.handler(async () => {
        await admin.passkeys.reset();

        return {};
      }),
    },
  };
}

function toOAuthClient(client: Readonly<ClientView>): OAuthClient {
  return {
    name: client.name,
    clientId: client.clientID,
    redirectUris: client.redirectURIs,
    createdAt: new Date(client.createdAt),
  };
}

async function withClientErrors<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof MCPAuthError)) {
      throw error;
    }

    throw match(error.code)
      .with('conflict', () => buildConflictError('oauth-client', name))
      .with('not-found', () => buildNotFoundError('oauth-client', name))
      .with(
        'invalid-client-name',
        'invalid-redirect-uri',
        () => new ImpdError('BAD_REQUEST', { message: error.message }),
      )
      .with('invalid-setup', () => error)
      .exhaustive();
  }
}

async function resolveClient(admin: MCPAuthAdmin, reference: string): Promise<ClientView> {
  const clients = await admin.clients.list();
  const named = await admin.clients.readByName(reference);

  const picked = pickOAuthClient(reference, clients, named);

  return match(picked)
    .with({ kind: 'found' }, (found) => found.client)
    .with({ kind: 'missing' }, () => {
      throw buildNotFoundError('oauth-client', reference);
    })
    .with({ kind: 'ambiguous' }, (ambiguous) => {
      throw buildConflictError(
        'oauth-client',
        reference,
        `${String(ambiguous.clientIDs.length)} clients are named ${reference}: ${ambiguous.clientIDs.join(', ')}; name one by its client ID`,
      );
    })
    .exhaustive();
}

function toOAuthGrant(
  grant: Readonly<GrantView>,
  tokens: Pick<TokenStore, 'findById'>,
): OAuthGrant {
  const approvedBy = grant.approvedBy.startsWith('token:')
    ? `token:${formatApprover(grant.approvedBy.slice('token:'.length), tokens)}`
    : grant.approvedBy;

  return {
    id: grant.grantID,
    client: grant.clientName,
    approvedBy,
    scope: pickGrantScope(grant.scopes),
    createdAt: new Date(grant.createdAt),
    lastUsedAt: grant.lastUsedAt === null ? null : new Date(grant.lastUsedAt),
  };
}

// a removed token's ID stays, since its name went with it
function formatApprover(tokenID: string, tokens: Pick<TokenStore, 'findById'>): string {
  return tokens.findById(tokenID)?.name ?? tokenID;
}
