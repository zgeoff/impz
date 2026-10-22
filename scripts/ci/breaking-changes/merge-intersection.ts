import type { MessageDirection } from '@impz/api';
import { ANNOTATIONS } from './annotations';
import { buildWithout } from './build-without';
import { collectSchemaMap } from './collect-schema-map';
import { findSchema } from './find-schema';
import { findSchemaList } from './find-schema-list';
import { findTypes } from './find-types';
import { isSchemaObject } from './is-schema-object';
import { JSON_TYPES } from './json-types';
import { resolveRef } from './resolve-ref';
import type { Schema, SchemaObject } from './schema';

export function mergeIntersection(
  schema: SchemaObject,
  root: Schema,
  direction: MessageDirection,
): readonly Schema[] {
  const parts = [buildWithout(schema, ['allOf']), ...(findSchemaList(schema, 'allOf') ?? [])].map(
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

function mergeIntersectionPair(
  left: SchemaObject,
  right: SchemaObject,
  direction: MessageDirection,
): SchemaObject | undefined {
  const merged: Record<string, unknown> = {
    ...buildWithout(left, OBJECT_KEYWORDS),
    ...mergeObjectKeywords(left, right, direction),
  };

  for (const [keyword, value] of Object.entries(right)) {
    if (OBJECT_KEYWORDS.includes(keyword)) {
      continue;
    }

    if (!(keyword in left)) {
      merged[keyword] = value;
      continue;
    }

    const combined = mergeKeyword(keyword, left[keyword], value);

    if (combined === undefined) {
      return undefined;
    }

    merged[keyword] = combined.value;
  }

  return merged;
}

// zod closes each object of an output on its own keys, though the value it sends carries the keys
// of every part, so a closed part binds only an input.
function mergeObjectKeywords(
  left: SchemaObject,
  right: SchemaObject,
  direction: MessageDirection,
): Record<string, unknown> {
  const parts = [left, right].map((part) => ({
    properties: collectSchemaMap(part, 'properties'),
    extra: findSchema(part, 'additionalProperties'),
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

  if ('properties' in left || 'properties' in right) {
    merged['properties'] = properties;
  }

  if (extra !== undefined) {
    merged['additionalProperties'] = extra;
  }

  return merged;
}

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
  left: unknown,
  right: unknown,
): { readonly value: unknown } | undefined {
  if (Bun.deepEquals(left, right, true) || ANNOTATIONS.has(keyword)) {
    return { value: left };
  }

  if (typeof left === 'number' && typeof right === 'number') {
    if (LOWER_KEYWORDS.has(keyword)) {
      return { value: Math.max(left, right) };
    }

    if (UPPER_KEYWORDS.has(keyword)) {
      return { value: Math.min(left, right) };
    }
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const both: readonly unknown[] = [left, right].flat();

    if (keyword === 'required') {
      return { value: [...new Set(both)] };
    }

    if (keyword === 'allOf') {
      return { value: both };
    }

    if (keyword === 'enum') {
      return {
        value: left.filter((value) => right.some((other) => Bun.deepEquals(value, other, true))),
      };
    }
  }

  if (keyword === 'type') {
    return mergeTypes({ type: left }, { type: right });
  }

  return undefined;
}

function mergeTypes(
  left: SchemaObject,
  right: SchemaObject,
): { readonly value: unknown } | undefined {
  const sides = [findTypes(left) ?? JSON_TYPES, findTypes(right) ?? JSON_TYPES];

  const common = JSON_TYPES.filter((type) =>
    sides.every((side) => side.includes(type) || (type === 'integer' && side.includes('number'))),
  );

  // A JSON Schema number already takes every integer.
  const types = common.includes('number') ? common.filter((type) => type !== 'integer') : common;

  if (types.length === 0) {
    return undefined;
  }

  return { value: types.length === 1 ? types[0] : types };
}
