import type { ApiCall } from '@impz/api';
import { listApiCalls, writeApiCall } from '../db/api-audit';
import type { ImpDatabase } from '../db/open-database';
import type { AuditActor } from '../principal/caller';
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
  readonly listCalls: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<ApiCall[]>;
}

interface ApiAuditDeps {
  readonly db: ImpDatabase;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly readErrorCode: (failure: unknown) => string;
}

export function createApiAudit(deps: ApiAuditDeps): ApiAudit {
  return {
    record: (call, failure) => {
      void writeCall(deps, call, failure);
    },
    listCalls: (impName, limit, patterns) => listApiCalls(deps.db, impName, limit, patterns),
  };
}

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

export async function withAuditedOpen<T>(
  audit: Pick<ApiAudit, 'record'>,
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
      outcome: failure === null ? 'ok' : deps.readErrorCode(failure),
      durationMs: Math.max(0, Math.round(now - call.startedAt)),
      detail: call.detail ?? null,
    });
  } catch (error) {
    deps.log(`impd: audit: ${call.procedure}: ${getErrorMessage(error)}`);
  }
}
