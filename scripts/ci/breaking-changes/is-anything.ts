import { ANNOTATIONS } from './annotations';
import type { Schema } from './schema';

export function isAnything(schema: Schema): boolean {
  return (
    schema === true ||
    (typeof schema === 'object' && Object.keys(schema).every((key) => ANNOTATIONS.has(key)))
  );
}
