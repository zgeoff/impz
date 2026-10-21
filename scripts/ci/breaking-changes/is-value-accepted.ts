import { match } from 'ts-pattern';
import type { Bound, Side } from './bound';
import { findBranches } from './find-branches';
import { findInclusive } from './find-inclusive';
import { findLower } from './find-lower';
import { findSchemaList } from './find-schema-list';
import { findTypes } from './find-types';
import { findUpper } from './find-upper';
import { findValues } from './find-values';
import { isWithin } from './is-within';
import { resolveRef } from './resolve-ref';
import type { Schema, SchemaObject } from './schema';

export function isValueAccepted(schemaRef: Schema, value: unknown, root: Schema): boolean {
  const schema = resolveRef(schemaRef, root);

  if (typeof schema === 'boolean') {
    return schema;
  }

  const branches = findBranches(schema);
  const parts = findSchemaList(schema, 'allOf') ?? [];
  const values = findValues(schema);
  const types = findTypes(schema);

  return (
    (branches === undefined || branches.some((branch) => isValueAccepted(branch, value, root))) &&
    parts.every((part) => isValueAccepted(part, value, root)) &&
    (values === undefined || values.some((option) => Bun.deepEquals(option, value, true))) &&
    (types === undefined || types.some((type) => isOfType(value, type))) &&
    (typeof value !== 'string' || isStringAccepted(schema, value)) &&
    (typeof value !== 'number' || isNumberAccepted(schema, value))
  );
}

function isOfType(value: unknown, type: string): boolean {
  return match(type)
    .with('integer', () => Number.isInteger(value))
    .with('null', () => value === null)
    .with('array', () => Array.isArray(value))
    .with('object', () => typeof value === 'object' && value !== null && !Array.isArray(value))
    .otherwise(() => typeof value === type);
}

function isStringAccepted(schema: SchemaObject, value: string): boolean {
  const length = countCodePoints(value);
  const pattern = schema['pattern'];

  return (
    isInBound(length, findInclusive(schema, 'minLength'), 'lower') &&
    isInBound(length, findInclusive(schema, 'maxLength'), 'upper') &&
    (typeof pattern !== 'string' || new RegExp(pattern, 'u').test(value))
  );
}

// JSON Schema counts a string's length in code points
function countCodePoints(value: string): number {
  return [...value.matchAll(/./gsu)].length;
}

function isInBound(value: number, bound: Bound | undefined, side: Side): boolean {
  return bound === undefined || isWithin({ value, exclusive: false }, bound, side);
}

function isNumberAccepted(schema: SchemaObject, value: number): boolean {
  const step = schema['multipleOf'];

  return (
    isInBound(value, findLower(schema), 'lower') &&
    isInBound(value, findUpper(schema), 'upper') &&
    (typeof step !== 'number' || value % step === 0)
  );
}
