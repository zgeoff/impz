import { isContractProcedure } from '@orpc/contract';
import * as z from 'zod';
import { ProcedureAccessSchema } from '../schemas/procedure-access-schema';
import type { ProcedureAccess } from '../schemas/procedure-access-schema';

interface ProcedureAccessEntry {
  readonly path: string;
  readonly access: ProcedureAccess | null;
}

const MetaSchema = z.object({ access: ProcedureAccessSchema });

export function collectProcedureAccess(router: object, prefix = ''): ProcedureAccessEntry[] {
  return Object.entries(router).flatMap(([key, value]: [string, unknown]) => {
    const path = `${prefix}${key}`;

    if (isContractProcedure(value)) {
      const meta: unknown = value['~orpc'].meta;
      const parsed = MetaSchema.safeParse(meta);

      return [{ path, access: parsed.success ? parsed.data.access : null }];
    }

    return typeof value === 'object' && value !== null
      ? collectProcedureAccess(value, `${path}.`)
      : [];
  });
}
