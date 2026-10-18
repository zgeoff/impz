import type { Schema } from './read-schema';
import { findRef, isSchema, isSchemaObject } from './read-schema';

// a local `$ref` (`#/$defs/…`), merged with the keywords beside it
export function resolveRef(schema: Schema, root: Schema): Schema {
  const ref = findRef(schema);

  if (typeof schema !== 'object' || ref === undefined) {
    return schema;
  }

  let target: unknown = root;

  for (const part of ref.replace(/^#\/?/u, '').split('/').filter(Boolean)) {
    target = isSchemaObject(target) ? target[decodePointer(part)] : undefined;
  }

  if (!isSchema(target)) {
    throw new TypeError(`unresolved $ref ${ref}`);
  }

  const { $ref: _ref, ...siblings } = schema;
  const resolved = resolveRef(target, root);

  return Object.keys(siblings).length === 0 || typeof resolved === 'boolean'
    ? resolved
    : { ...resolved, ...siblings };
}

function decodePointer(part: string): string {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}
