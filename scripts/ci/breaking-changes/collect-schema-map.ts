import { isSchema } from './is-schema';
import { isSchemaObject } from './is-schema-object';
import type { Schema, SchemaObject } from './schema';

export function collectSchemaMap(
  schema: SchemaObject,
  keyword: string,
): Readonly<Record<string, Schema>> {
  const value = schema[keyword];

  if (!isSchemaObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Schema] => isSchema(entry[1])),
  );
}
