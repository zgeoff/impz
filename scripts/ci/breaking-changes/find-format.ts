import type { SchemaObject } from './schema';

// zod writes the name of its own string check as the format, beside the
// pattern that holds the check; a validator passes over a format it does not
// know, so the name constrains nothing
const ZOD_CHECK_FORMATS = new Set([
  'includes',
  'starts_with',
  'ends_with',
  'lowercase',
  'uppercase',
]);

export function findFormat(schema: SchemaObject): unknown {
  const format = schema['format'];

  return typeof format === 'string' && ZOD_CHECK_FORMATS.has(format) ? undefined : format;
}
