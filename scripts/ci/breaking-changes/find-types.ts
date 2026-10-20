import { getStrings } from './get-strings';
import type { SchemaObject } from './schema';

export function findTypes(schema: SchemaObject): readonly string[] | undefined {
  const type = schema['type'];

  if (typeof type === 'string') {
    return [type];
  }

  return Array.isArray(type) ? getStrings(schema, 'type') : undefined;
}
