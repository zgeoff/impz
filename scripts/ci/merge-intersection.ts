import type { MessageDirection } from '../../packages/api/src/protocols/build-protocol-schema';
import { ANNOTATIONS } from './is-anything';
import type { Schema, SchemaObject } from './read-schema';
import {
  JSON_TYPES,
  buildWithout,
  isSchemaObject,
  readSchema,
  readSchemaList,
  readSchemaMap,
  readTypes,
} from './read-schema';
import { resolveRef } from './resolve-ref';

// an intersection, with its siblings, as the fewest schemas a value must pass at once
export function mergeIntersection(
  schema: SchemaObject,
  root: Schema,
  direction: MessageDirection,
): readonly Schema[] {
  const parts = [buildWithout(schema, ['allOf']), ...(readSchemaList(schema, 'allOf') ?? [])].map(
    (part) => resolveRef(part, root),
  );

  if (parts.includes(false)) {
    return [false];
  }

  return mergeIntersectionParts(
    parts.filter((part) => isSchemaObject(part)),
    direction,
  );
}

// each part folded into the first group whose keywords it combines with
function mergeIntersectionParts(
  parts: readonly SchemaObject[],
  direction: MessageDirection,
): readonly SchemaObject[] {
  const groups: SchemaObject[] = [];

  for (const part of parts) {
    const index = groups.findIndex(
      (group) => mergeIntersectionPair(group, part, direction) !== undefined,
    );

    const merged =
      index === -1 ? undefined : mergeIntersectionPair(groups[index] ?? {}, part, direction);

    if (merged === undefined) {
      groups.push(part);
    } else {
      groups[index] = merged;
    }
  }

  return groups;
}

const OBJECT_KEYWORDS = ['properties', 'additionalProperties'];

// one schema that takes exactly the values both take, or none when a keyword
// conflicts in a way no one schema can state
function mergeIntersectionPair(
  a: SchemaObject,
  b: SchemaObject,
  direction: MessageDirection,
): SchemaObject | undefined {
  const merged: Record<string, unknown> = {
    ...buildWithout(a, OBJECT_KEYWORDS),
    ...mergeObjectKeywords(a, b, direction),
  };

  for (const [keyword, value] of Object.entries(b)) {
    if (OBJECT_KEYWORDS.includes(keyword)) {
      continue;
    }

    if (!(keyword in a)) {
      merged[keyword] = value;
      continue;
    }

    const combined = mergeKeyword(keyword, a[keyword], value);

    if (combined === undefined) {
      return undefined;
    }

    merged[keyword] = combined.value;
  }

  return merged;
}

// A key that one part names falls to the other part's `additionalProperties`.
// zod closes each object of an output on its own keys, though the value it
// sends carries the keys of every part, so a closed part binds only an input.
function mergeObjectKeywords(
  a: SchemaObject,
  b: SchemaObject,
  direction: MessageDirection,
): Record<string, unknown> {
  const parts = [a, b].map((part) => ({
    properties: readSchemaMap(part, 'properties'),
    extra: readSchema(part, 'additionalProperties'),
  }));

  const keys = [...new Set(parts.flatMap((part) => Object.keys(part.properties)))];

  const properties = Object.fromEntries(
    keys.map((key) => [
      key,
      mergeSchemaList(
        parts.map(
          (part) =>
            part.properties[key] ??
            (part.extra === false && direction === 'toClient' ? undefined : part.extra),
        ),
      ),
    ]),
  );

  const extra = mergeSchemaList(parts.map((part) => part.extra));
  const merged: Record<string, unknown> = {};

  if ('properties' in a || 'properties' in b) {
    merged['properties'] = properties;
  }

  if (extra !== undefined) {
    merged['additionalProperties'] = extra;
  }

  return merged;
}

// the schemas a value must pass at once, as one schema
function mergeSchemaList(schemas: readonly (Schema | undefined)[]): Schema | undefined {
  const given = schemas.filter((schema) => schema !== undefined);

  const distinct = given.filter(
    (schema, index) =>
      schema !== true && given.findIndex((other) => Bun.deepEquals(other, schema, true)) === index,
  );

  if (distinct.includes(false)) {
    return false;
  }

  if (distinct.length === 0) {
    return given.length === 0 ? undefined : true;
  }

  return distinct.length === 1 ? distinct[0] : { allOf: distinct };
}

const LOWER_KEYWORDS = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems']);
const UPPER_KEYWORDS = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems']);

function mergeKeyword(
  keyword: string,
  a: unknown,
  b: unknown,
): { readonly value: unknown } | undefined {
  if (Bun.deepEquals(a, b, true) || ANNOTATIONS.has(keyword)) {
    return { value: a };
  }

  if (typeof a === 'number' && typeof b === 'number') {
    if (LOWER_KEYWORDS.has(keyword)) {
      return { value: Math.max(a, b) };
    }

    if (UPPER_KEYWORDS.has(keyword)) {
      return { value: Math.min(a, b) };
    }
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const both: readonly unknown[] = [a, b].flat();

    if (keyword === 'required') {
      return { value: [...new Set(both)] };
    }

    if (keyword === 'allOf') {
      return { value: both };
    }

    // the values both list
    if (keyword === 'enum') {
      return { value: a.filter((value) => b.some((other) => Bun.deepEquals(value, other, true))) };
    }
  }

  if (keyword === 'type') {
    return mergeTypes({ type: a }, { type: b });
  }

  return undefined;
}

// the types both sides take, where an integer is also a number
function mergeTypes(a: SchemaObject, b: SchemaObject): { readonly value: unknown } | undefined {
  const sides = [readTypes(a) ?? JSON_TYPES, readTypes(b) ?? JSON_TYPES];

  const common = JSON_TYPES.filter((type) =>
    sides.every((side) => side.includes(type) || (type === 'integer' && side.includes('number'))),
  );

  // a number on both sides already takes every integer
  const types = common.includes('number') ? common.filter((type) => type !== 'integer') : common;

  if (types.length === 0) {
    return undefined;
  }

  return { value: types.length === 1 ? types[0] : types };
}
