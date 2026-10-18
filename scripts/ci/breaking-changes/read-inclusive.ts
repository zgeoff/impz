import type { Bound } from './bound';
import type { SchemaObject } from './schema';

export function readInclusive(schema: SchemaObject, keyword: string): Bound | undefined {
  const value = schema[keyword];

  return typeof value === 'number' ? { value, exclusive: false } : undefined;
}
