import { hasScope, isImpAllowed } from '@impz/api';
import type { ForbiddenReason, ImpContract, Scope } from '@impz/api';
import type { ForkAuthority } from '../../platform/db/create-fork-grants';
import type { GrantAuthority } from '../../platform/db/secrets';
import { formatCaller } from './caller';
import type { Caller } from './caller';
import { checkGrantable } from './check-grantable';
import { checkImageAdd } from './check-image-add';

interface HostAccess {
  readonly scope: Scope;
  readonly on: 'host';

  readonly audit?: false | 'refusals';
}

interface ImpAccess {
  readonly scope: Scope;
  readonly on: 'imp';
  readonly fields: readonly string[];

  readonly noGrantable?: true;
  readonly audit?: false;
}

interface GrantAccess {
  readonly scope: Scope;
  readonly on: 'grant';
  readonly fields: readonly string[];
  readonly secretField: string;
  readonly audit?: false;
}

interface ImageAccess {
  readonly scope: Scope;
  readonly on: 'image';
  readonly audit?: false | 'refusals';
}

interface AnyAccess {
  readonly scope: Scope;
  readonly on: 'any';
  readonly audit?: false;
}

export type Access = HostAccess | ImpAccess | GrantAccess | ImageAccess | AnyAccess;

export interface Refusal {
  readonly message: string;
  readonly reason: ForbiddenReason | null;
}

export type ReadSecretGeneration = (name: string) => Promise<string | null>;

type ProcedurePath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends { readonly '~orpc': unknown }
    ? `${Prefix}${K}`
    : ProcedurePath<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type ImpProcedurePath = ProcedurePath<ImpContract>;

const IMP = ['name'] as const;
const readAny: Access = { scope: 'read', on: 'any' };
const readImp: Access = { scope: 'read', on: 'imp', fields: IMP };
const execImp: Access = { scope: 'exec', on: 'imp', fields: IMP };
const manageImp: Access = { scope: 'manage', on: 'imp', fields: IMP };
const manageHost: Access = { scope: 'manage', on: 'host' };
const manageImpNoGrantable: Access = { ...manageImp, noGrantable: true };
const manageGrant: Access = { scope: 'manage', on: 'grant', fields: IMP, secretField: 'secret' };

export const PROCEDURE_ACCESS: Readonly<Record<ImpProcedurePath, Access>> = {
  'imps.create': manageImp,
  'imps.list': readAny,
  'imps.get': readImp,
  'imps.destroy': manageImp,
  'imps.start': execImp,
  'imps.stop': execImp,
  'imps.sleep': execImp,
  'imps.wake': execImp,
  'imps.hold': execImp,
  'imps.url': readImp,

  'imps.policy': readImp,
  'imps.setPolicy': manageImp,

  // who reaches an imp from the internet is the host's call, either way: a
  // token for one imp must not publish it, nor change what another set up
  'imps.expose': manageHost,
  'imps.unexpose': manageHost,

  // a bigger disk spends the host's disk budget, as a create does
  'imps.resizeDisk': manageImp,

  // a CPU limit or weight takes from, or gives back to, the other imps, and
  // a new HTTP port moves the imp's URL to another service
  'imps.update': manageImp,
  'imps.fork': { scope: 'manage', on: 'imp', fields: ['source', 'name'], noGrantable: true },

  'leases.acquire': execImp,
  'leases.renew': execImp,
  'leases.release': execImp,
  'leases.list': { scope: 'exec', on: 'any', audit: false },

  // a move hands the whole imp, its disk and checkpoints, to another host;
  // on the target a ticket takes in an image and grants, which are host-wide
  'moves.prepare': manageImpNoGrantable,
  'moves.facts': manageHost,
  'moves.receive': manageHost,
  'moves.send': manageImpNoGrantable,
  'moves.status': readImp,
  'moves.reissue': manageHost,
  'moves.resume': manageImpNoGrantable,
  'moves.abort': manageImp,

  'checkpoints.create': manageImp,
  'checkpoints.list': readImp,
  'checkpoints.restore': manageImp,
  'checkpoints.delete': manageImp,

  // a backup holds every imp; a restore can replace any of them
  'backups.run': manageHost,
  'backups.list': { scope: 'read', on: 'host' },
  'backups.restore': manageHost,
  'backups.check': manageHost,

  'images.list': readAny,

  // an image is the host's, but a token for some imps may add one under
  // its own names from the registry path it was given; a build or a
  // template stays host-wide
  'images.add': { scope: 'manage', on: 'image' },
  'images.build': manageHost,

  'images.addStream': { scope: 'manage', on: 'image', audit: 'refusals' },
  'images.buildStream': { scope: 'manage', on: 'host', audit: 'refusals' },
  'images.delete': manageHost,
  'images.pin': manageHost,
  'images.unpin': manageHost,

  // a running build's steps show its Dockerfile's commands: host-wide
  'images.builds': { scope: 'read', on: 'host' },

  'exec.ticket': { ...execImp, audit: false },

  'sessions.list': readImp,
  'sessions.kill': execImp,

  // a session's output can hold anything its program printed: reading or
  // deleting it is for those who may attach, and each read is audited
  'sessions.logs': readImp,
  'sessions.readLog': execImp,
  'sessions.deleteLog': execImp,

  // a service runs a command as an exec does, and its log can hold
  // anything the command prints
  'services.list': readImp,
  'services.add': execImp,
  'services.remove': execImp,
  'services.restart': execImp,
  'services.logs': execImp,

  // whoever may run a command in the imp may write a file there as root
  'files.write': execImp,
  'files.remove': execImp,

  // secrets belong to the host: a grant hands one to an imp, so a token
  // limited to some imps could grant itself any secret
  'secrets.add': manageHost,
  'secrets.list': readAny,
  'secrets.delete': manageHost,
  'secrets.refresh': manageHost,

  // a member reaches every other imp on the network, so a token limited to
  // some imps could reach past them; list shows the caller's imps only
  'networks.list': readAny,
  'networks.create': manageHost,
  'networks.delete': manageHost,
  'networks.join': manageHost,
  'networks.leave': manageHost,
  'networks.warnings': readImp,

  'grants.add': manageGrant,
  'grants.delete': manageGrant,
  'grants.list': readImp,
  'grants.details': readImp,

  'audit.list': readAny,
  'audit.refused': readAny,
  'audit.calls': readAny,
  'events.stream': readAny,
  'system.info': readAny,
  'system.features': readAny,

  'system.gc': manageHost,

  'oauth.clients.list': manageHost,
  'oauth.clients.add': manageHost,
  'oauth.clients.update': manageHost,
  'oauth.clients.delete': manageHost,
  'oauth.grants.list': manageHost,
  'oauth.grants.delete': manageHost,
  'oauth.approvals.get': readAny,
  'oauth.approvals.approve': readAny,

  // the copy holds every imp, token hash and grant
  'system.copyDatabase': manageHost,

  'tokens.list': manageHost,
  'tokens.create': manageHost,
  'tokens.update': manageHost,
  'tokens.delete': manageHost,
  'tokens.addKey': manageHost,
  'tokens.removeKey': manageHost,
  'tokens.whoami': readAny,
};

const ACCESS_BY_PATH: ReadonlyMap<string, Access> = new Map(Object.entries(PROCEDURE_ACCESS));

export function findAccess(procedure: string): Access | null {
  return ACCESS_BY_PATH.get(procedure) ?? null;
}

export function isAuditedProcedure(procedure: string): boolean {
  const access = findAccess(procedure);

  return access === null || (access.scope !== 'read' && access.audit === undefined);
}

export function isRefusalAudited(procedure: string): boolean {
  return findAccess(procedure)?.audit === 'refusals';
}

export async function checkAccess(
  access: Readonly<Access> | null,
  caller: Readonly<Caller>,
  input: unknown,
  readSecretGeneration: ReadSecretGeneration,
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
    readSecretGeneration,
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
