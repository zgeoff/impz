import type { Scope } from '@impz/api';
import type { Access } from '@zgeoff/mcp-auth';
import type { Caller } from '../../platform/principal/caller';
import { pickGrantScope } from './grant-limits';
import type { ImpLimits } from './imp-limits-schema';
import type { ServiceClients } from './read-service-files';

type ServiceAccess = Extract<Access<Scope, ImpLimits>, { kind: 'service' }>;

// A client the token file names but the clients file does not would reach every imp, so it gets no
// caller; with no scope left, the lowest scope would still read every imp its entry names.
export function buildServiceCaller(
  access: Readonly<ServiceAccess>,
  clients: ServiceClients,
): Caller | null {
  const entry = clients[access.clientName.slice('service:'.length)];

  if (entry === undefined || access.scopes.length === 0) {
    return null;
  }

  return {
    kind: 'service',
    name: access.clientName,
    scope: pickGrantScope(access.scopes),
    imps: entry.imps,
    grantable: [],
    imageRefPrefix: null,
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: access.clientName,
    display: `${access.clientName} via client credentials`,
  };
}
