import type { SchemaObject } from './schema';

export function buildWithout(
  schema: SchemaObject,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}
