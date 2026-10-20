import { isSchema } from './is-schema';
import type { Schema, SchemaObject } from './schema';

export function findSchema(schema: SchemaObject, keyword: string): Schema | undefined {
  const value = schema[keyword];

  return isSchema(value) ? value : undefined;
}
