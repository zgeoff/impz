import { ScopeSchema } from '@impz/api';

// each of imp's scopes with the lower ones it holds; any other word stays,
// for better-auth to refuse
export function expandScopes(asked: readonly string[]): string[] {
  // imp's scopes, lowest first, as words a request may hold
  const SCOPE_ORDER: readonly string[] = ScopeSchema.options;

  const expanded = asked.flatMap((word) => {
    const index = SCOPE_ORDER.indexOf(word);

    return index === -1 ? [word] : SCOPE_ORDER.slice(0, index + 1);
  });

  return [...new Set(expanded)];
}
