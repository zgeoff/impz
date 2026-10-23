import { oc } from '@orpc/contract';
import type { ProcedureAccess } from '../schemas/procedure-access-schema';
import { IMP_ERRORS } from './imp-errors';

export interface ProcedureMeta {
  readonly access?: ProcedureAccess;
}

export const contractBase = oc.$meta<ProcedureMeta>({}).errors(IMP_ERRORS);
