import type { SchemaObject } from './schema';

export function readStrings(schema: SchemaObject, keyword: string): readonly string[] {
  const value: unknown = schema[keyword];

  if (!Array.isArray(value)) {
    return [];
  }

  const items: readonly unknown[] = value;

  return items.filter((item): item is string => typeof item === 'string');
}
