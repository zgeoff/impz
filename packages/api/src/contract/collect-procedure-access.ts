import { isContractProcedure } from '@orpc/contract';
import { ProcedureAccessSchema } from '../schemas/procedure-access-schema';
import type { ProcedureAccess } from '../schemas/procedure-access-schema';

interface ProcedureAccessEntry {
  readonly path: string;
  readonly access: ProcedureAccess | null;
}

export function collectProcedureAccess(router: object, prefix = ''): ProcedureAccessEntry[] {
  return Object.entries(router).flatMap(([key, value]: [string, unknown]) => {
    const path = `${prefix}${key}`;

    if (isContractProcedure(value)) {
      const parsed = ProcedureAccessSchema.safeParse(value['~orpc'].meta.access);

      return [{ path, access: parsed.success ? parsed.data : null }];
    }

    return typeof value === 'object' && value !== null
      ? collectProcedureAccess(value, `${path}.`)
      : [];
  });
}
