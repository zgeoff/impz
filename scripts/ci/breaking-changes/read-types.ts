import { readStrings } from './read-strings';
import type { SchemaObject } from './schema';

export function readTypes(schema: SchemaObject): readonly string[] | undefined {
  const type = schema['type'];

  if (typeof type === 'string') {
    return [type];
  }

  return Array.isArray(type) ? readStrings(schema, 'type') : undefined;
}
