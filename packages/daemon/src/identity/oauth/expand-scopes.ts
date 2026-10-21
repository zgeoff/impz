import { ScopeSchema } from '@impz/api';

export function expandScopes(asked: readonly string[]): string[] {
  const SCOPE_ORDER: readonly string[] = ScopeSchema.options;

  const expanded = asked.flatMap((word) => {
    const index = SCOPE_ORDER.indexOf(word);

    return index === -1 ? [word] : SCOPE_ORDER.slice(0, index + 1);
  });

  return [...new Set(expanded)];
}
