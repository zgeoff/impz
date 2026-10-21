// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 moves the caller into platform
import type { AuditActor } from '../../identity/auth/caller';
import { writeApiCall } from '../db/api-audit';
import type { ImpDatabase } from '../db/open-database';
import { getErrorMessage } from '../process/get-error-message';

const IMP_NAMESPACES: ReadonlySet<string> = new Set([
  'imps',
  'checkpoints',
  'backups',
  'sessions',
  'grants',
  'files',
]);

export interface AuditedCall {
  readonly procedure: string;
  readonly actor: AuditActor;
  readonly impName: string | null;
  readonly startedAt: number;

  readonly detail?: string | null;
}

export interface ApiAudit {
  readonly record: (call: AuditedCall, failure: unknown) => void;
}

interface ApiAuditDeps {
  readonly db: ImpDatabase;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function createApiAudit(deps: ApiAuditDeps): ApiAudit {
  return {
    record: (call, failure) => {
      void writeCall(deps, call, failure);
    },
  };
}

// Only the name: the input itself is never kept.
export function findImpName(procedure: string, input: unknown, output: unknown): string | null {
  const namespace = procedure.split('.')[0] ?? '';

  if (procedure === 'images.add' || procedure === 'images.addStream') {
    return findField(input, 'imp');
  }

  if (!IMP_NAMESPACES.has(namespace)) {
    return null;
  }

  return findField(input, 'name') ?? findField(output, 'name');
}

function findField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }

  const field: unknown = Reflect.get(value, key);

  return typeof field === 'string' ? field : null;
}

function readOutcome(failure: unknown): string {
  if (failure === null) {
    return 'ok';
  }

  return failure instanceof ORPCError ? String(failure.code) : 'INTERNAL_SERVER_ERROR';
}

export async function withAuditedOpen<T>(
  audit: ApiAudit,
  call: AuditedCall,
  open: () => Promise<T>,
): Promise<T> {
  try {
    const opened = await open();

    audit.record(call, null);

    return opened;
  } catch (error) {
    audit.record(call, error);
    throw error;
  }
}

async function writeCall(deps: ApiAuditDeps, call: AuditedCall, failure: unknown): Promise<void> {
  const now = deps.now();

  try {
    await writeApiCall(deps.db, {
      at: new Date(now),
      procedure: call.procedure,
      actor: call.actor.kind,
      actorName: call.actor.name,
      impName: call.impName,
      outcome: readOutcome(failure),
      durationMs: Math.max(0, Math.round(now - call.startedAt)),
      detail: call.detail ?? null,
    });
  } catch (error) {
    deps.log(`impd: audit: ${call.procedure}: ${getErrorMessage(error)}`);
  }
}
