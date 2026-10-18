import type { Bound, Side } from './bound';
import { isWithin, readInclusive, readLower, readUpper } from './bound';
import type { Comparison } from './comparison';
import { formatChange, formatSides } from './format-change';
import { formatValue } from './format-value';
import type { SchemaObject } from './read-schema';

export function collectBoundChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const step = wide['multipleOf'];
  const narrowStep = narrow['multipleOf'];

  const fitsStep =
    typeof step !== 'number' || (typeof narrowStep === 'number' && narrowStep % step === 0);

  const stepChange = formatSides(comparison, narrowStep, step, formatValue);

  const pairs = [
    ['lower bound', readLower(narrow), readLower(wide), 'lower'],
    ['upper bound', readUpper(narrow), readUpper(wide), 'upper'],
    ['min items', readInclusive(narrow, 'minItems'), readInclusive(wide, 'minItems'), 'lower'],
    ['max items', readInclusive(narrow, 'maxItems'), readInclusive(wide, 'maxItems'), 'upper'],
  ] as const;

  return [
    ...pairs.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange(name, narrowBound, wideBound, side, path, comparison),
    ),
    ...(fitsStep ? [] : [formatChange(path, `multipleOf ${stepChange}`)]),
  ];
}

export function collectBoundChange(
  name: string,
  narrow: Bound | undefined,
  wide: Bound | undefined,
  side: Side,
  path: string,
  comparison: Comparison,
): string[] {
  if (wide === undefined || (narrow !== undefined && isWithin(narrow, wide, side))) {
    return [];
  }

  const change = formatSides(comparison, narrow, wide, (bound) => formatBound(bound, side));

  return [formatChange(path, `${name} ${change}`)];
}

function formatBound(bound: Bound | undefined, side: Side): string {
  if (bound === undefined) {
    return 'none';
  }

  const sign = side === 'lower' ? '>' : '<';

  return `${bound.exclusive ? sign : `${sign}=`} ${String(bound.value)}`;
}
