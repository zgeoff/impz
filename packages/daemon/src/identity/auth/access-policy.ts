import { callerContract, collectProcedureAccess, hasScope, isImpAllowed } from '@impz/api';
import type { CallerAccess, ForbiddenReason, ProcedureMeta } from '@impz/api';
import type { ForkAuthority } from '../../platform/db/create-fork-grants';
import type { ImageRecord } from '../../platform/db/images';
import type { GrantAuthority } from '../../platform/db/secrets';
import { formatCaller } from '../../platform/principal/caller';
import type { Caller } from '../../platform/principal/caller';
import { checkGrantable } from './check-grantable';
import { checkImageAdd } from './check-image-add';
import { checkImagePin } from './check-image-pin';

export type Access = CallerAccess;

export interface Refusal {
  readonly message: string;
  readonly reason: ForbiddenReason | null;
}

export type ReadSecretGeneration = (name: string) => Promise<string | null>;

export type ReadImage = (name: string) => Promise<Pick<ImageRecord, 'ref'> | undefined>;

export interface AccessReaders {
  readonly readSecretGeneration: ReadSecretGeneration;
  readonly readImage: ReadImage;
}

/* @internal */
export const PROCEDURE_ACCESS: Readonly<Record<string, Access>> = Object.fromEntries(
  collectProcedureAccess(callerContract).flatMap((entry) => {
    const access = toCallerAccess(entry.access);

    return access === null ? [] : [[entry.path, access]];
  }),
);

const ACCESS_BY_PATH: ReadonlyMap<string, Access> = new Map(Object.entries(PROCEDURE_ACCESS));

/* @internal */
export function findAccess(procedure: string): Access | null {
  return ACCESS_BY_PATH.get(procedure) ?? null;
}

export function findDeclaredAccess(meta: Readonly<ProcedureMeta>): Access | null {
  return toCallerAccess(meta.access ?? null);
}

/* @internal */
export function isAuditedProcedure(procedure: string): boolean {
  return isAuditedAccess(findAccess(procedure));
}

export function isAuditedAccess(access: Readonly<Access> | null): boolean {
  return access === null || (access.scope !== 'read' && access.audit === undefined);
}

/* @internal */
export function isRefusalAudited(procedure: string): boolean {
  return isRefusalAuditedAccess(findAccess(procedure));
}

export function isRefusalAuditedAccess(access: Readonly<Access> | null): boolean {
  return access?.audit === 'refusals';
}

export async function checkAccess(
  access: Readonly<Access> | null,
  caller: Readonly<Caller>,
  input: unknown,
  readers: Readonly<AccessReaders>,
): Promise<Refusal | null> {
  if (access === null) {
    return { message: 'this call has no access rule', reason: null };
  }

  if (!hasScope(caller.scope, access.scope)) {
    return {
      message: `${formatCaller(caller)} has scope ${caller.scope}; this needs ${access.scope}`,
      reason: 'scope',
    };
  }

  if (access.on === 'grant' && caller.kind === 'oauth') {
    return { message: `${formatCaller(caller)} may not grant or revoke secrets`, reason: null };
  }

  if (access.on === 'imp' && access.noGrantable === true && caller.grantable.length > 0) {
    return {
      message: `${formatCaller(caller)} may grant secrets, so it may not fork or move an imp`,
      reason: null,
    };
  }

  if (access.on === 'any' || caller.imps === null) {
    return null;
  }

  if (access.on === 'image' && access.held === true) {
    return checkImagePin(caller, caller.imps, findField(input, 'name'), readers.readImage);
  }

  if (access.on === 'image') {
    return checkImageAdd(caller, caller.imps, {
      ref: findField(input, 'ref'),
      name: findField(input, 'name'),
      hasImp: typeof input === 'object' && input !== null && 'imp' in input,
    });
  }

  if (access.on === 'host') {
    return {
      message: `${formatCaller(caller)} is limited to some imps; this call is host-wide`,
      reason: null,
    };
  }

  const outside = findOutsideImp(access.fields, caller, caller.imps, input);

  if (outside !== null || access.on === 'imp') {
    return outside;
  }

  const refusal = await checkGrantable(
    caller,
    findField(input, access.secretField),
    readers.readSecretGeneration,
  );

  return refusal;
}

export function findGrantAuthority(
  caller: Readonly<Caller>,
  secret: string,
): GrantAuthority | null {
  if (caller.imps === null) {
    return null;
  }

  const entry = caller.grantable.find((each) => each.name === secret);

  if (entry === undefined || caller.tokenId === null) {
    throw new Error(`${formatCaller(caller)} reached a grant of ${secret} it may not make`);
  }

  return { tokenId: caller.tokenId, generation: entry.generation };
}

export function findForkAuthority(caller: Readonly<Caller>): ForkAuthority | null {
  return caller.imps === null ? null : { tokenId: caller.tokenId, grantable: caller.grantable };
}

function toCallerAccess(access: Readonly<ProcedureMeta>['access'] | null): Access | null {
  return access === undefined || access === null || access.on === 'none' ? null : access;
}

function findOutsideImp(
  fields: readonly string[],
  caller: Readonly<Caller>,
  patterns: readonly string[],
  input: unknown,
): Refusal | null {
  for (const field of fields) {
    const name = findField(input, field);

    if (name === null) {
      return {
        message: `${formatCaller(caller)} is limited to some imps, so the call must name the imp (${field})`,
        reason: 'imp_out_of_scope',
      };
    }

    if (!isImpAllowed(patterns, name)) {
      return {
        message: `${formatCaller(caller)} may not touch imp ${name}`,
        reason: 'imp_out_of_scope',
      };
    }
  }

  return null;
}

export function findField(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const value: unknown = Reflect.get(input, field);

  return typeof value === 'string' ? value : null;
}
