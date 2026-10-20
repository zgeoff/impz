import type { Schema } from './schema';

export function findValues(schema: Schema): unknown[] | undefined {
  if (typeof schema !== 'object') {
    return undefined;
  }

  if ('const' in schema) {
    return [schema['const']];
  }

  return Array.isArray(schema['enum']) ? schema['enum'] : undefined;
}
