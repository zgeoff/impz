import { GrantPatternSchema, ScopeSchema, hasScope } from '@impz/api';
import type { Scope } from '@impz/api';

export function isGrantPattern(pattern: string): boolean {
  return GrantPatternSchema.safeParse(pattern).success;
}

export function isPatternsWithin(
  grant: readonly string[] | null,
  token: readonly string[] | null,
): boolean {
  if (token === null) {
    return true;
  }

  if (grant === null) {
    return false;
  }

  return grant.every((pattern) => token.some((own) => isPatternWithin(pattern, own)));
}

function isPatternWithin(pattern: string, own: string): boolean {
  if (pattern === own) {
    return true;
  }

  const star = own.indexOf('*');

  return star === own.length - 1 && pattern.startsWith(own.slice(0, -1));
}

export function readLowerScope(left: Scope, right: Scope): Scope {
  return hasScope(left, right) ? right : left;
}

export function formatScopeList(scope: Scope): string {
  const nested: Record<Scope, string> = {
    read: 'read',
    exec: 'read exec',
    manage: 'read exec manage',
  };

  return nested[scope];
}

export function pickGrantScope(scopes: readonly string[]): Scope {
  return ScopeSchema.options.reduce<Scope>(
    (highest, scope) => (scopes.includes(scope) && hasScope(scope, highest) ? scope : highest),
    'read',
  );
}
