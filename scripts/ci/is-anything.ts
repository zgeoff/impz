import type { Schema } from './read-schema';

// keywords that describe a value without constraining it
export const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

export function isAnything(schema: Schema): boolean {
  return (
    schema === true ||
    (typeof schema === 'object' && Object.keys(schema).every((key) => ANNOTATIONS.has(key)))
  );
}
