import { GrantPatternSchema } from '@impz/api';
import type { ImpLimits } from './imp-limits-schema';

const MAX_PATTERNS = 32;

type ParsedConsentImps =
  | { readonly ok: true; readonly limits: ImpLimits }
  | { readonly ok: false; readonly error: string };

// The owner types the imp patterns on the consent page, split by spaces or commas.
export function parseConsentImps(form: URLSearchParams): ParsedConsentImps {
  const patterns = [
    ...new Set((form.get('imps') ?? '').split(/[\s,]+/v).filter((pattern) => pattern !== '')),
  ];

  if (patterns.length === 0) {
    return { ok: false, error: 'Name at least one imp, or * for every imp.' };
  }

  if (patterns.length > MAX_PATTERNS) {
    return { ok: false, error: `Name at most ${String(MAX_PATTERNS)} imp patterns.` };
  }

  const bad = patterns.find((pattern) => !GrantPatternSchema.safeParse(pattern).success);

  if (bad !== undefined) {
    return {
      ok: false,
      error: 'Each pattern must be an imp name, or a name prefix and a trailing *, such as dev-*.',
    };
  }

  return { ok: true, limits: { imps: patterns, grantable: false } };
}
