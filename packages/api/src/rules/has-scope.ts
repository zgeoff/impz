import { ScopeSchema } from '../schemas/token-schema';

const RANKED: readonly string[] = ScopeSchema.options;

// Takes strings so a caller can hold a scope that is not in the list, which has no rank.
export function hasScope(granted: string, needed: string): boolean {
  const grantedRank = RANKED.indexOf(granted);
  const neededRank = RANKED.indexOf(needed);

  return grantedRank !== -1 && neededRank !== -1 && grantedRank >= neededRank;
}
