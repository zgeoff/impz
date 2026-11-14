import { ScopeSchema } from '@impz/api';
import type { Scope } from '@impz/api';
import { DEFAULT_PATHS, openMCPAuth, openMCPAuthAdmin } from '@zgeoff/mcp-auth';
import type { Access, MCPAuth, MCPAuthAdmin, MCPAuthAdminOptions } from '@zgeoff/mcp-auth';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { Caller } from '../../platform/principal/caller';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { Revocations } from '../auth/revocations';
import type { TokenStore } from '../auth/token-store';
import { buildImpGrantLimits } from './build-imp-grant-limits';
import { buildOAuthCaller } from './build-oauth-caller';
import { buildServiceCaller } from './build-service-caller';
import type { ImpLimits } from './imp-limits-schema';
import type { PublicMcpConfig } from './public-mcp-config';
import { SERVICE_TOKEN_PREFIX, readServiceSettings } from './read-service-files';
import type { ServiceClients, ServiceSettings } from './read-service-files';
import { recordSecurityEvent } from './record-security-event';

// The passkey and enrollment tables are new with the shared OAuth server, so impd names them; the
// clients and grants stay in better-auth's tables.
const TABLES = { passkey: 'oauth_passkeys', enrollmentToken: 'oauth_enrollment_tokens' };

export interface ImpdMcpAuth {
  readonly admin: MCPAuthAdmin;

  // null when impd serves no public MCP route
  readonly server: MCPAuth<Scope, ImpLimits> | null;
  readonly readCaller: (access: Access<Scope, ImpLimits>) => Promise<Caller | null>;

  // ends each grant that the imp token approved, before the owner's passkey approved each one
  readonly removeTokenGrants: (tokenID: string) => Promise<void>;
}

interface ImpdMcpAuthDeps {
  readonly db: ImpDatabase;
  readonly tokens: Pick<TokenStore, 'findById'>;
  readonly revocations: Pick<Revocations, 'revoke'>;
  readonly config: PublicMcpConfig | null;
  readonly now: () => number;
}

export async function createImpdMcpAuth(deps: Readonly<ImpdMcpAuthDeps>): Promise<ImpdMcpAuth> {
  const log = getImpdLogger('oauth');

  const options = {
    database: deps.db,
    scopes: ScopeSchema.options,
    tables: TABLES,
    clock: { now: deps.now },
    onGrantRevoked: (grantID: string) => {
      deps.revocations.revoke(grantID);
      log.info('grant {id} revoked', { id: grantID });
    },
  };

  const config = deps.config;

  // With no public route, impd still keeps the clients, grants and passkeys its CLI manages.
  const serviceFiles = config?.serviceFiles ?? null;
  const service = serviceFiles === null ? null : await readServiceSettings(serviceFiles);

  const opened =
    config === null
      ? { server: null, admin: await openMCPAuthAdmin(options) }
      : await openImpdServer(options, config, deps.tokens, service);

  const serviceClients: ServiceClients = service?.clients ?? {};
  const server = opened.server;
  const admin = opened.admin;

  return {
    admin,
    server,
    removeTokenGrants: async (tokenID) => {
      const grants = await admin.grants.list();

      for (const grant of grants) {
        if (grant.approvedBy === `token:${tokenID}`) {
          await admin.grants.revoke(grant.grantID);
        }
      }
    },
    readCaller: async (access) => {
      if (access.kind === 'service') {
        return buildServiceCaller(access, serviceClients);
      }

      const grant = await deps.db
        .selectFrom('user')
        .select('approvedBy')
        .where('id', '=', access.grantID)
        .executeTakeFirst();

      const approvedBy = grant?.approvedBy ?? null;

      if (approvedBy === null) {
        return null;
      }

      if (!approvedBy.startsWith('token:')) {
        return buildOAuthCaller(access, null);
      }

      const approver = deps.tokens.findById(approvedBy.slice('token:'.length));

      return approver === null ? null : buildOAuthCaller(access, approver);
    },
  };
}

async function openImpdServer(
  options: Readonly<MCPAuthAdminOptions<Scope>>,
  config: Readonly<PublicMcpConfig>,
  tokens: Pick<TokenStore, 'findById'>,
  service: Readonly<ServiceSettings> | null,
) {
  const server = await openMCPAuth<Scope, ImpLimits>({
    ...options,
    origin: config.origin,
    productName: 'imp',
    paths: DEFAULT_PATHS,
    grantLimits: buildImpGrantLimits({ findToken: tokens.findById }),
    ...(service === null
      ? {}
      : { serviceTokens: { prefix: SERVICE_TOKEN_PREFIX, file: service.tokens } }),
    security: { record: recordSecurityEvent },
  });

  return { server, admin: server };
}
