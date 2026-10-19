import type { Schema } from './schema';

export function findRef(schema: Schema): string | undefined {
  return typeof schema === 'object' && typeof schema['$ref'] === 'string'
    ? schema['$ref']
    : undefined;
}
