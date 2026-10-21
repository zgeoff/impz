import * as z from 'zod';
import { TailnetRulesSchema } from './tailnet-identity';
import type { TailnetRule } from './tailnet-identity';

export function parseTailnetRules(text: string | undefined): readonly TailnetRule[] | null {
  if (text === undefined) {
    return null;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('IMP_TAILNET_IDENTITIES is not JSON');
  }

  const rules = TailnetRulesSchema.safeParse(json);

  if (!rules.success) {
    throw new Error(`IMP_TAILNET_IDENTITIES: ${z.prettifyError(rules.error)}`);
  }

  return rules.data;
}
