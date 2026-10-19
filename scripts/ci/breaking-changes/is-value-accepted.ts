import { match } from 'ts-pattern';
import type { Bound, Side } from './bound';
import { isWithin } from './is-within';
import { readBranches } from './read-branches';
import { readInclusive } from './read-inclusive';
import { readLower } from './read-lower';
import { readSchemaList } from './read-schema-list';
import { readTypes } from './read-types';
import { readUpper } from './read-upper';
import { readValues } from './read-values';
import { resolveRef } from './resolve-ref';
import type { Schema, SchemaObject } from './schema';

// a plain validator for the values of a `const` or an `enum`
export function isValueAccepted(schemaRef: Schema, value: unknown, root: Schema): boolean {
  const schema = resolveRef(schemaRef, root);

  if (typeof schema === 'boolean') {
    return schema;
  }

  const branches = readBranches(schema);
  const parts = readSchemaList(schema, 'allOf') ?? [];
  const values = readValues(schema);
  const types = readTypes(schema);

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
  // a schema's type is any string, so the match ends in the typeof check
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
    isInBound(length, readInclusive(schema, 'minLength'), 'lower') &&
    isInBound(length, readInclusive(schema, 'maxLength'), 'upper') &&
    (typeof pattern !== 'string' || new RegExp(pattern, 'u').test(value))
  );
}

// JSON Schema counts a string's length in code points
function countCodePoints(value: string): number {
  return [...value.matchAll(/./gsu)].length;
}

function isNumberAccepted(schema: SchemaObject, value: number): boolean {
  const step = schema['multipleOf'];

  return (
    isInBound(value, readLower(schema), 'lower') &&
    isInBound(value, readUpper(schema), 'upper') &&
    (typeof step !== 'number' || value % step === 0)
  );
}

function isInBound(value: number, bound: Bound | undefined, side: Side): boolean {
  return bound === undefined || isWithin({ value, exclusive: false }, bound, side);
}
