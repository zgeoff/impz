export type Schema = boolean | Readonly<Record<string, unknown>>;

export type SchemaObject = Readonly<Record<string, unknown>>;

export function readSchema(schema: SchemaObject, keyword: string): Schema | undefined {
  const value = schema[keyword];

  return isSchema(value) ? value : undefined;
}

export function readSchemaList(
  schema: SchemaObject,
  keyword: string,
): readonly Schema[] | undefined {
  const value: unknown = schema[keyword];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items: readonly unknown[] = value;

  return items.filter((item): item is Schema => isSchema(item));
}

export function readSchemaMap(
  schema: SchemaObject,
  keyword: string,
): Readonly<Record<string, Schema>> {
  const value = schema[keyword];

  if (!isSchemaObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Schema] => isSchema(entry[1])),
  );
}

export function readStrings(schema: SchemaObject, keyword: string): readonly string[] {
  const value: unknown = schema[keyword];

  if (!Array.isArray(value)) {
    return [];
  }

  const items: readonly unknown[] = value;

  return items.filter((item): item is string => typeof item === 'string');
}

export function readBranches(schema: SchemaObject): readonly Schema[] | undefined {
  return readSchemaList(schema, 'anyOf') ?? readSchemaList(schema, 'oneOf');
}

export function buildWithout(
  schema: SchemaObject,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}

export function readValues(schema: Schema): unknown[] | undefined {
  if (typeof schema !== 'object') {
    return undefined;
  }

  if ('const' in schema) {
    return [schema['const']];
  }

  return Array.isArray(schema['enum']) ? schema['enum'] : undefined;
}

export const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];

export function readTypes(schema: SchemaObject): readonly string[] | undefined {
  const type = schema['type'];

  if (typeof type === 'string') {
    return [type];
  }

  return Array.isArray(type) ? readStrings(schema, 'type') : undefined;
}

export function findRef(schema: Schema): string | undefined {
  return typeof schema === 'object' && typeof schema['$ref'] === 'string'
    ? schema['$ref']
    : undefined;
}

export function isSchema(value: unknown): value is Schema {
  return typeof value === 'boolean' || isSchemaObject(value);
}

export function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
