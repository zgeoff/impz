import type { SchemaObject } from './read-schema';

export interface Bound {
  readonly value: number;
  readonly exclusive: boolean;
}

export type Side = 'lower' | 'upper';

export function readLower(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMinimum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(readInclusive(schema, 'minimum'), exclusiveBound, 'lower');
}

export function readUpper(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMaximum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(readInclusive(schema, 'maximum'), exclusiveBound, 'upper');
}

export function readInclusive(schema: SchemaObject, keyword: string): Bound | undefined {
  const value = schema[keyword];

  return typeof value === 'number' ? { value, exclusive: false } : undefined;
}

function pickTighter(a: Bound | undefined, b: Bound | undefined, side: Side): Bound | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }

  return isWithin(a, b, side) ? a : b;
}

// whether bound `inner` admits no value that bound `outer` refuses
export function isWithin(inner: Bound, outer: Bound, side: Side): boolean {
  const ahead = side === 'lower' ? inner.value > outer.value : inner.value < outer.value;

  return ahead || (inner.value === outer.value && (inner.exclusive || !outer.exclusive));
}
