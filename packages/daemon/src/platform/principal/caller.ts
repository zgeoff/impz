import { hasScope, isImpAllowed } from '@impz/api';
import type { ApiActor, Identity, Scope } from '@impz/api';
import type { GrantableSecret } from '../db/tokens';

export interface Caller {
  readonly kind: ApiActor;

  readonly name: string;
  readonly scope: Scope;

  readonly imps: readonly string[] | null;

  readonly grantable: readonly GrantableSecret[];

  readonly imageRefPrefix: string | null;

  readonly tokenId: string | null;

  readonly grantId: string | null;

  readonly expiresAt: number | null;

  readonly principal: string | null;

  readonly display: string;
}

export type AuditActor = Pick<Caller, 'kind' | 'name'>;

export function isCallerAllowed(caller: Readonly<Caller>, scope: Scope, name: string): boolean {
  return hasScope(caller.scope, scope) && isImpAllowed(caller.imps, name);
}

export function toIdentity(caller: Readonly<Caller>): Identity {
  return {
    kind: caller.kind,
    name: caller.name,
    scope: caller.scope,
    imps: caller.imps,
    grantable: caller.grantable.map((secret) => secret.name),
    imageRefPrefix: caller.imageRefPrefix,
  };
}

export function formatCaller(caller: Readonly<Caller>): string {
  return `${caller.kind} ${caller.name}`;
}
