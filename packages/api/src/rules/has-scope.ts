import { ScopeSchema } from '../schemas/token-schema';
import type { Scope } from '../schemas/token-schema';

export function hasScope(granted: Scope, needed: Scope): boolean {
  const grantedRank = ScopeSchema.options.indexOf(granted);
  const neededRank = ScopeSchema.options.indexOf(needed);

  return grantedRank !== -1 && neededRank !== -1 && grantedRank >= neededRank;
}
