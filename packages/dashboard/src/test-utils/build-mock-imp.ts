import type { Imp } from '@impz/api';
import { ImpRowSchema } from '../mocks/db/imp-collection';

export function buildMockImp(overrides: Partial<Imp> = {}): Imp {
  return ImpRowSchema.parse(overrides);
}
