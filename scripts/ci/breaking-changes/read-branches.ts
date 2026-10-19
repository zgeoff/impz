import { readSchemaList } from './read-schema-list';
import type { Schema, SchemaObject } from './schema';

export function readBranches(schema: SchemaObject): readonly Schema[] | undefined {
  return readSchemaList(schema, 'anyOf') ?? readSchemaList(schema, 'oneOf');
}
