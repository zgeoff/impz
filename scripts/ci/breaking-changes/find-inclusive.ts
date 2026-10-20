import type { Bound } from './bound';
import type { SchemaObject } from './schema';

export function findInclusive(schema: SchemaObject, keyword: string): Bound | undefined {
  const value = schema[keyword];

  return typeof value === 'number' ? { value, exclusive: false } : undefined;
}
