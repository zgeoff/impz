import { findSchemaList } from './find-schema-list';
import type { Schema, SchemaObject } from './schema';

export function findBranches(schema: SchemaObject): readonly Schema[] | undefined {
  return findSchemaList(schema, 'anyOf') ?? findSchemaList(schema, 'oneOf');
}
