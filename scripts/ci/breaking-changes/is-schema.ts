import { isSchemaObject } from './is-schema-object';
import type { Schema } from './schema';

export function isSchema(value: unknown): value is Schema {
  return typeof value === 'boolean' || isSchemaObject(value);
}
