import type { MessageDirection } from '@impz/api';
import { ANNOTATIONS } from './annotations';
import { buildWithout } from './build-without';
import { collectBoundChange } from './collect-bound-change';
import { collectBoundChanges } from './collect-bound-changes';
import { collectSchemaMap } from './collect-schema-map';
import type { Comparison } from './comparison';
import { findBranches } from './find-branches';
import { findFormat } from './find-format';
import { findInclusive } from './find-inclusive';
import { findRef } from './find-ref';
import { findSchema } from './find-schema';
import { findSchemaList } from './find-schema-list';
import { collectTagKeys } from './find-tag-keys';
import { findTypes } from './find-types';
import { findValues } from './find-values';
import { formatChange } from './format-change';
import { formatSides } from './format-sides';
import { formatTag } from './format-tag';
import { formatValue } from './format-value';
import { formatValues } from './format-values';
import { getStrings } from './get-strings';
import { hasOtherTag } from './has-other-tag';
import { isAnything } from './is-anything';
import { isPatternNarrowed } from './is-pattern-narrowed';
import { isSchemaObject } from './is-schema-object';
import { isValueAccepted } from './is-value-accepted';
import { JSON_TYPES } from './json-types';
import { mergeIntersection } from './merge-intersection';
import { resolveRef } from './resolve-ref';
import type { Schema, SchemaObject } from './schema';

interface CollectSchemaChangesOptions {
  readonly label: string;
  readonly direction: MessageDirection;
  readonly before: Schema;
  readonly after: Schema;
  readonly hasStableFields?: boolean;
}

export function collectSchemaChanges(options: CollectSchemaChangesOptions): string[] {
  const direction = options.direction;

  const [narrow, wide] =
    direction === 'toServer' ? [options.before, options.after] : [options.after, options.before];

  const comparison = {
    direction,
    narrowRoot: narrow,
    wideRoot: wide,
    seen: new Set<string>(),
    hasStableFields: options.hasStableFields ?? false,
  };

  return collectChanges(narrow, wide, '', comparison).map((change) => `${options.label}${change}`);
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

// An intersection's merge rebuilds an intersection over `$ref`s at each level of a recursive
// schema, so the whole intersection names it.
function findCycleKey(schema: Schema): string | undefined {
  const ref = findRef(schema);

  if (ref !== undefined || typeof schema !== 'object') {
    return ref;
  }

  const parts = findSchemaList(schema, 'allOf') ?? [];

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
  const narrowBranches = findBranches(narrow);
  const wideBranches = findBranches(wide);

  if (narrowBranches !== undefined) {
    const siblings = buildWithout(narrow, ['anyOf', 'oneOf']);

    const keys =
      wideBranches === undefined
        ? []
        : collectTagKeys([
            resolveBranches(narrowBranches, comparison.narrowRoot),
            resolveBranches(wideBranches, comparison.wideRoot),
          ]);

    const dropped =
      comparison.direction === 'toClient' && wideBranches !== undefined
        ? collectDroppedVariants({
            narrowBranches,
            wideBranches,
            tagKeys: keys,
            path,
            comparison,
          })
        : [];

    const inner = { ...comparison, unionTags: { path, keys } };

    return [
      ...dropped,
      ...narrowBranches.flatMap((branch) =>
        collectChanges(mergeSchemas(siblings, branch), wide, path, inner),
      ),
    ];
  }

  if (findSchemaList(narrow, 'allOf') !== undefined) {
    return collectIntersectionChanges(narrow, wide, path, comparison);
  }

  if (findValues(narrow) !== undefined) {
    return collectValueChanges(narrow, wide, path, comparison);
  }

  const narrowTypes = findTypes(narrow) ?? [];

  // a type list is a union of one schema per type, each of which one option
  // of the wide union must take
  if (wideBranches !== undefined && narrowTypes.length > 1) {
    return narrowTypes.flatMap((type) =>
      collectChanges({ ...narrow, type }, wide, path, comparison),
    );
  }

  if (wideBranches !== undefined) {
    return collectUnionChanges({ narrow, wide, branches: wideBranches, path, comparison });
  }

  const wideParts = findSchemaList(wide, 'allOf');

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

function resolveBranches(branches: readonly Schema[], root: Schema): readonly SchemaObject[] {
  return branches
    .map((branch) => resolveRef(branch, root))
    .filter((branch) => isSchemaObject(branch));
}

interface CollectDroppedVariantsOptions {
  readonly narrowBranches: readonly Schema[];
  readonly wideBranches: readonly Schema[];
  readonly tagKeys: readonly string[];
  readonly path: string;
  readonly comparison: Comparison;
}

function collectDroppedVariants(options: CollectDroppedVariantsOptions): string[] {
  const tagKeys = options.tagKeys;
  const comparison = options.comparison;

  if (tagKeys.length === 0) {
    return [];
  }

  const narrowObjects = resolveBranches(options.narrowBranches, comparison.narrowRoot);

  return resolveBranches(options.wideBranches, comparison.wideRoot)
    .filter((branch) => narrowObjects.every((other) => hasOtherTag(other, branch, tagKeys)))
    .map((branch) =>
      formatChange(options.path, `no longer sends the variant ${formatTag(branch, tagKeys)}`),
    );
}

function mergeSchemas(siblings: SchemaObject, branch: Schema): Schema {
  return typeof branch === 'boolean' ? branch : { ...siblings, ...branch };
}

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

function collectValueChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  // A client passes over a value it does not know, so impd may add one to a closed set it sends.
  if (comparison.direction === 'toClient' && isClosedSet(wide, comparison.wideRoot)) {
    return [];
  }

  const verb = comparison.direction === 'toServer' ? 'no longer accepts' : 'may now be';

  // An intersection's merge can leave a listed value that the other keywords refuse, and no
  // value ever took it.
  return (findValues(narrow) ?? [])
    .filter((value) => isValueAccepted(narrow, value, comparison.narrowRoot))
    .filter((value) => !isValueAccepted(wide, value, comparison.wideRoot))
    .map((value) => formatChange(path, `${verb} ${formatValue(value)}`));
}

function isClosedSet(schemaRef: Schema, root: Schema): boolean {
  const schema = resolveRef(schemaRef, root);

  if (typeof schema !== 'object') {
    return false;
  }

  const branches = findBranches(schema);

  return (
    findValues(schema) !== undefined ||
    (branches !== undefined && branches.every((branch) => isClosedSet(branch, root)))
  );
}

interface CollectUnionChangesOptions {
  readonly narrow: SchemaObject;
  readonly wide: SchemaObject;
  readonly branches: readonly Schema[];
  readonly path: string;
  readonly comparison: Comparison;
}

function collectUnionChanges(options: CollectUnionChangesOptions): string[] {
  const narrow = options.narrow;
  const wide = options.wide;
  const branches = options.branches;
  const path = options.path;
  const comparison = options.comparison;
  const siblings = buildWithout(wide, ['anyOf', 'oneOf']);

  const siblingChanges = isAnything(siblings)
    ? []
    : collectChanges(narrow, siblings, path, comparison);

  const tagKeys =
    comparison.unionTags?.path === path
      ? comparison.unionTags.keys
      : collectTagKeys([[narrow], resolveBranches(branches, comparison.wideRoot)]);

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
  const [closest = []] = trials.toSorted((left, right) => left.length - right.length);

  return [...siblingChanges, ...closest];
}

function collectTypeChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const wideTypes = findTypes(wide);
  const narrowTypes = findTypes(narrow) ?? JSON_TYPES;
  const wideValues = findValues(wide);

  const fits =
    wideTypes === undefined ||
    narrowTypes.every(
      (type) => wideTypes.includes(type) || (type === 'integer' && wideTypes.includes('number')),
    );

  const typeChange = formatSides(comparison, findTypes(narrow), wideTypes, formatTypes);
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
    ['min length', findInclusive(narrow, 'minLength'), findInclusive(wide, 'minLength'), 'lower'],
    ['max length', findInclusive(narrow, 'maxLength'), findInclusive(wide, 'maxLength'), 'upper'],
  ] as const;

  const exact = [
    ['pattern', narrow['pattern'], wide['pattern']],
    ['format', findFormat(narrow), findFormat(wide)],
  ] as const;

  const changes = exact
    .filter(([, narrowValue, wideValue]) => wideValue !== undefined && narrowValue !== wideValue)
    .filter(
      ([keyword, narrowValue, wideValue]) =>
        keyword !== 'pattern' || !isPatternNarrowed(narrowValue, wideValue),
    )
    .map(([keyword, narrowValue, wideValue]) => {
      const change = formatSides(comparison, narrowValue, wideValue, formatValue);

      return formatChange(path, `${keyword} ${change}`);
    });

  return [
    ...lengths.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange({ name, narrow: narrowBound, wide: wideBound, side, path, comparison }),
    ),
    ...changes,
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

  const narrowItems = findSchema(narrow, 'items') ?? true;
  const wideItems = findSchema(wide, 'items') ?? true;

  return collectChanges(narrowItems, wideItems, `${path}[]`, comparison);
}

function collectPropertyChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const narrowProperties = collectSchemaMap(narrow, 'properties');
  const wideProperties = collectSchemaMap(wide, 'properties');
  const narrowRequired = getStrings(narrow, 'required');
  const wideRequired = getStrings(wide, 'required');
  const wideExtra = findSchema(wide, 'additionalProperties');
  const narrowExtra = findSchema(narrow, 'additionalProperties');
  const recordValues = typeof wideExtra === 'object' ? wideExtra : undefined;
  const missing = comparison.direction === 'toServer' ? 'now required' : 'may now be missing';

  const required = wideRequired
    .filter((key) => !narrowRequired.includes(key))
    .map((key) => formatChange(`${path}.${key}`, missing));

  const properties = Object.entries(narrowProperties).flatMap(([key, schema]) => {
    const wideProperty = wideProperties[key] ?? recordValues;

    if (schema === false) {
      return [];
    }

    if (wideProperty !== undefined) {
      return collectChanges(schema, wideProperty, `${path}.${key}`, comparison);
    }

    return comparison.direction === 'toServer' ? [formatChange(`${path}.${key}`, 'removed')] : [];
  });

  // A `--json` reader names the fields it reads, so dropping an optional property breaks it.
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

function collectKeyChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const wideKeys = findSchema(wide, 'propertyNames');

  if (wideKeys === undefined) {
    return [];
  }

  const narrowKeys = findSchema(narrow, 'propertyNames') ?? { type: 'string' };

  return collectChanges(narrowKeys, wideKeys, `${path}{key}`, comparison);
}

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
