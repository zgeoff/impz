import type { MessageDirection } from '../../../packages/api/src/protocols/build-protocol-schema';
import { ANNOTATIONS } from './annotations';
import { buildWithout } from './build-without';
import { collectBoundChange } from './collect-bound-change';
import { collectBoundChanges } from './collect-bound-changes';
import type { Comparison } from './comparison';
import { findRef } from './find-ref';
import { findTagKeys } from './find-tag-keys';
import { formatChange } from './format-change';
import { formatSides } from './format-sides';
import { formatTag } from './format-tag';
import { formatValue } from './format-value';
import { formatValues } from './format-values';
import { hasOtherTag } from './has-other-tag';
import { isAnything } from './is-anything';
import { isSchemaObject } from './is-schema-object';
import { isValueAccepted } from './is-value-accepted';
import { JSON_TYPES } from './json-types';
import { mergeIntersection } from './merge-intersection';
import { readBranches } from './read-branches';
import { readInclusive } from './read-inclusive';
import { readSchema } from './read-schema';
import { readSchemaList } from './read-schema-list';
import { readSchemaMap } from './read-schema-map';
import { readStrings } from './read-strings';
import { readTypes } from './read-types';
import { readValues } from './read-values';
import { resolveRef } from './resolve-ref';
import type { Schema, SchemaObject } from './schema';

// Every value of the narrow side must pass the wide side: base's into head's
// for what impd reads, head's into base's for what it sends.
export function collectSchemaChanges(
  label: string,
  direction: MessageDirection,
  before: Schema,
  after: Schema,
  hasStableFields = false,
): string[] {
  const [narrow, wide] = direction === 'toServer' ? [before, after] : [after, before];

  const comparison = {
    direction,
    narrowRoot: narrow,
    wideRoot: wide,
    seen: new Set<string>(),
    hasStableFields,
  };

  return collectChanges(narrow, wide, '', comparison).map((change) => `${label}${change}`);
}

function collectChanges(
  narrowRef: Schema,
  wideRef: Schema,
  path: string,
  comparison: Comparison,
): string[] {
  const refKey = `${findCycleKey(narrowRef) ?? ''}|${findCycleKey(wideRef) ?? ''}`;

  if (refKey !== '|' && comparison.seen.has(refKey)) {
    return [];
  }

  const inner =
    refKey === '|' ? comparison : { ...comparison, seen: new Set([...comparison.seen, refKey]) };

  const narrow = resolveRef(narrowRef, comparison.narrowRoot);
  const wide = resolveRef(wideRef, comparison.wideRoot);

  if (isAnything(wide) || narrow === false) {
    return [];
  }

  if (typeof wide === 'boolean' || typeof narrow === 'boolean' || isAnything(narrow)) {
    return [formatChange(path, `accepts ${formatSides(comparison, narrow, wide, formatSchema)}`)];
  }

  return collectObjectChanges(narrow, wide, path, inner);
}

// What names a schema that a recursive schema meets again: its `$ref`, or the
// whole of an intersection over `$ref`s, which a merge rebuilds at each level.
function findCycleKey(schema: Schema): string | undefined {
  const ref = findRef(schema);

  if (ref !== undefined || typeof schema !== 'object') {
    return ref;
  }

  const parts = readSchemaList(schema, 'allOf') ?? [];

  return parts.some((part) => findRef(part) !== undefined) ? JSON.stringify(schema) : undefined;
}

function formatSchema(schema: Schema): string {
  if (schema === false) {
    return 'nothing';
  }

  return isAnything(schema) ? 'any value' : 'some values';
}

function collectObjectChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const narrowBranches = readBranches(narrow);
  const wideBranches = readBranches(wide);

  // a union: each of its options must pass, against the discriminator both
  // sides share; impd must still send every variant it sent
  if (narrowBranches !== undefined) {
    const siblings = buildWithout(narrow, ['anyOf', 'oneOf']);

    const keys =
      wideBranches === undefined
        ? []
        : findTagKeys([
            resolveBranches(narrowBranches, comparison.narrowRoot),
            resolveBranches(wideBranches, comparison.wideRoot),
          ]);

    const dropped =
      comparison.direction === 'toClient' && wideBranches !== undefined
        ? collectDroppedVariants(narrowBranches, wideBranches, keys, path, comparison)
        : [];

    const inner = { ...comparison, unionTags: { path, keys } };

    return [
      ...dropped,
      ...narrowBranches.flatMap((branch) =>
        collectChanges(mergeSchemas(siblings, branch), wide, path, inner),
      ),
    ];
  }

  if (readSchemaList(narrow, 'allOf') !== undefined) {
    return collectIntersectionChanges(narrow, wide, path, comparison);
  }

  if (readValues(narrow) !== undefined) {
    return collectValueChanges(narrow, wide, path, comparison);
  }

  if (wideBranches !== undefined) {
    return collectUnionChanges(narrow, wide, wideBranches, path, comparison);
  }

  const wideParts = readSchemaList(wide, 'allOf');

  if (wideParts !== undefined) {
    return mergeIntersection(wide, comparison.wideRoot, comparison.direction).flatMap((group) =>
      collectChanges(narrow, group, path, comparison),
    );
  }

  return [
    ...collectTypeChanges(narrow, wide, path, comparison),
    ...collectBoundChanges(narrow, wide, path, comparison),
    ...collectStringChanges(narrow, wide, path, comparison),
    ...collectItemChanges(narrow, wide, path, comparison),
    ...collectPropertyChanges(narrow, wide, path, comparison),
    ...collectKeywordChanges(narrow, wide, path, comparison),
  ];
}

function mergeSchemas(siblings: SchemaObject, branch: Schema): Schema {
  return typeof branch === 'boolean' ? branch : { ...siblings, ...branch };
}

// An intersection's parts merge into one schema where their keywords combine;
// of parts that stay apart, one alone must pass, failing which the first one's
// changes stand for it.
function collectIntersectionChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const groups = mergeIntersection(narrow, comparison.narrowRoot, comparison.direction);

  if (groups.length === 1) {
    return collectChanges(groups[0] ?? true, wide, path, comparison);
  }

  const trials = groups.map((group) => collectChanges(group, wide, path, comparison));
  const [first = []] = trials;

  return trials.some((trial) => trial.length === 0) ? [] : first;
}

// A closed set of values: each must pass, but impd may add one to a closed
// set it sends, as a client passes over a value it does not know.
function collectValueChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  if (comparison.direction === 'toClient' && isClosedSet(wide, comparison.wideRoot)) {
    return [];
  }

  const verb = comparison.direction === 'toServer' ? 'no longer accepts' : 'may now be';

  // a listed value that the narrow side's other keywords refuse, as an
  // intersection's merge may leave, was never taken
  return (readValues(narrow) ?? [])
    .filter((value) => isValueAccepted(narrow, value, comparison.narrowRoot))
    .filter((value) => !isValueAccepted(wide, value, comparison.wideRoot))
    .map((value) => formatChange(path, `${verb} ${formatValue(value)}`));
}

// a schema that admits only listed values: a `const`, an `enum`, or a union of them
function isClosedSet(schemaRef: Schema, root: Schema): boolean {
  const schema = resolveRef(schemaRef, root);

  if (typeof schema !== 'object') {
    return false;
  }

  const branches = readBranches(schema);

  return (
    readValues(schema) !== undefined ||
    (branches !== undefined && branches.every((branch) => isClosedSet(branch, root)))
  );
}

// One option of the wide union must take the whole narrow schema; when none
// does, the closest option's changes are the ones to show.
function collectUnionChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  branches: readonly Schema[],
  path: string,
  comparison: Comparison,
): string[] {
  const siblings = buildWithout(wide, ['anyOf', 'oneOf']);

  const siblingChanges = isAnything(siblings)
    ? []
    : collectChanges(narrow, siblings, path, comparison);

  // A variant whose tag no option shares is a new one, which a client passes
  // over; impd still reads every variant it read before.
  const tagKeys =
    comparison.unionTags?.path === path
      ? comparison.unionTags.keys
      : findTagKeys([[narrow], resolveBranches(branches, comparison.wideRoot)]);

  const sameTag = branches.filter(
    (branch) => !hasOtherTag(narrow, resolveRef(branch, comparison.wideRoot), tagKeys),
  );

  if (sameTag.length === 0) {
    const removed = formatChange(
      path,
      `no longer accepts the variant ${formatTag(narrow, tagKeys)}`,
    );

    return comparison.direction === 'toServer' ? [...siblingChanges, removed] : siblingChanges;
  }

  const trials = sameTag.map((branch) => collectChanges(narrow, branch, path, comparison));
  const [closest = []] = trials.toSorted((a, b) => a.length - b.length);

  return [...siblingChanges, ...closest];
}

// What impd sends must keep every variant an older client waits for: a base
// variant whose tag no head variant carries is no longer sent.
function collectDroppedVariants(
  narrowBranches: readonly Schema[],
  wideBranches: readonly Schema[],
  tagKeys: readonly string[],
  path: string,
  comparison: Comparison,
): string[] {
  if (tagKeys.length === 0) {
    return [];
  }

  const narrowObjects = resolveBranches(narrowBranches, comparison.narrowRoot);

  return resolveBranches(wideBranches, comparison.wideRoot)
    .filter((branch) => narrowObjects.every((other) => hasOtherTag(other, branch, tagKeys)))
    .map((branch) =>
      formatChange(path, `no longer sends the variant ${formatTag(branch, tagKeys)}`),
    );
}

function resolveBranches(branches: readonly Schema[], root: Schema): readonly SchemaObject[] {
  return branches
    .map((branch) => resolveRef(branch, root))
    .filter((branch) => isSchemaObject(branch));
}

// the type, and a closed set that the wide side brings where the narrow had none
function collectTypeChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const wideTypes = readTypes(wide);
  const narrowTypes = readTypes(narrow) ?? JSON_TYPES;
  const wideValues = readValues(wide);

  const fits =
    wideTypes === undefined ||
    narrowTypes.every(
      (type) => wideTypes.includes(type) || (type === 'integer' && wideTypes.includes('number')),
    );

  const typeChange = formatSides(comparison, readTypes(narrow), wideTypes, formatTypes);
  const valueChange = formatSides(comparison, undefined, wideValues, formatValues);

  return [
    ...(fits ? [] : [formatChange(path, `type ${typeChange}`)]),
    ...(wideValues === undefined ? [] : [formatChange(path, `values ${valueChange}`)]),
  ];
}

function formatTypes(types: readonly string[] | undefined): string {
  return types === undefined ? 'any' : types.join(' | ');
}

function collectStringChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const lengths = [
    ['min length', readInclusive(narrow, 'minLength'), readInclusive(wide, 'minLength'), 'lower'],
    ['max length', readInclusive(narrow, 'maxLength'), readInclusive(wide, 'maxLength'), 'upper'],
  ] as const;

  const exact = (['pattern', 'format'] as const)
    .filter((keyword) => wide[keyword] !== undefined && narrow[keyword] !== wide[keyword])
    .map((keyword) => {
      const change = formatSides(comparison, narrow[keyword], wide[keyword], formatValue);

      return formatChange(path, `${keyword} ${change}`);
    });

  return [
    ...lengths.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange(name, narrowBound, wideBound, side, path, comparison),
    ),
    ...exact,
  ];
}

function collectItemChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  if (narrow['items'] === undefined && wide['items'] === undefined) {
    return [];
  }

  const narrowItems = readSchema(narrow, 'items') ?? true;
  const wideItems = readSchema(wide, 'items') ?? true;

  return collectChanges(narrowItems, wideItems, `${path}[]`, comparison);
}

function collectPropertyChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const narrowProperties = readSchemaMap(narrow, 'properties');
  const wideProperties = readSchemaMap(wide, 'properties');
  const narrowRequired = readStrings(narrow, 'required');
  const wideRequired = readStrings(wide, 'required');
  const wideExtra = readSchema(wide, 'additionalProperties');
  const narrowExtra = readSchema(narrow, 'additionalProperties');
  const recordValues = typeof wideExtra === 'object' ? wideExtra : undefined;
  const missing = comparison.direction === 'toServer' ? 'now required' : 'may now be missing';

  const required = wideRequired
    .filter((key) => !narrowRequired.includes(key))
    .map((key) => formatChange(`${path}.${key}`, missing));

  const properties = Object.entries(narrowProperties).flatMap(([key, schema]) => {
    const wideProperty = wideProperties[key] ?? recordValues;

    // a property no value can take, as one an intersection's closed part refuses
    if (schema === false) {
      return [];
    }

    if (wideProperty !== undefined) {
      return collectChanges(schema, wideProperty, `${path}.${key}`, comparison);
    }

    return comparison.direction === 'toServer' ? [formatChange(`${path}.${key}`, 'removed')] : [];
  });

  // an optional property that head's output drops, for a reader that names it
  const dropped = comparison.hasStableFields
    ? Object.keys(wideProperties)
        .filter((key) => !(key in narrowProperties) && !wideRequired.includes(key))
        .map((key) => formatChange(`${path}.${key}`, 'removed'))
    : [];

  return [
    ...required,
    ...properties,
    ...dropped,
    ...collectRecordChanges(narrowExtra, wideExtra, path, comparison),
    ...collectKeyChanges(narrow, wide, path, comparison),
  ];
}

// a record's values
function collectRecordChanges(
  narrowExtra: Schema | undefined,
  wideExtra: Schema | undefined,
  path: string,
  comparison: Comparison,
): string[] {
  if (typeof wideExtra === 'object' && typeof narrowExtra === 'object') {
    return collectChanges(narrowExtra, wideExtra, `${path}{}`, comparison);
  }

  const closes =
    comparison.direction === 'toServer' && typeof narrowExtra === 'object' && wideExtra === false;

  return closes ? [formatChange(path, 'no longer takes keys beyond its named properties')] : [];
}

// a record's keys
function collectKeyChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const wideKeys = readSchema(wide, 'propertyNames');

  if (wideKeys === undefined) {
    return [];
  }

  const narrowKeys = readSchema(narrow, 'propertyNames') ?? { type: 'string' };

  return collectChanges(narrowKeys, wideKeys, `${path}{key}`, comparison);
}

// The keywords read one by one; a change to any other counts as breaking,
// as nothing here can tell which way it goes.
const MODELED = new Set([
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  '$defs',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
]);

function collectKeywordChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  return Object.entries(wide)
    .filter(
      ([keyword, value]) =>
        !ANNOTATIONS.has(keyword) &&
        !MODELED.has(keyword) &&
        !Bun.deepEquals(narrow[keyword], value, true),
    )
    .map(([keyword, value]) => {
      const change = formatSides(comparison, narrow[keyword], value, formatValue);

      return formatChange(path, `${keyword} ${change}`);
    });
}
