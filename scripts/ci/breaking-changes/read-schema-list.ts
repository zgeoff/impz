import { isSchema } from './is-schema';
import type { Schema, SchemaObject } from './schema';

export function readSchemaList(
  schema: SchemaObject,
  keyword: string,
): readonly Schema[] | undefined {
  const value: unknown = schema[keyword];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items: readonly unknown[] = value;

  return items.filter((item): item is Schema => isSchema(item));
}
