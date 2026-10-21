import { ScalarType, fromJson } from '@bufbuild/protobuf';
import type { DescField, DescMessage, JsonValue, MessageShape } from '@bufbuild/protobuf';

export function decodeAgentMessage<Desc extends DescMessage>(
  schema: Desc,
  json: JsonValue,
): MessageShape<Desc> {
  // A newer agent may send a field this impd does not know.
  const message = fromJson(schema, json, { ignoreUnknownFields: true });

  // A false or missing `ok` is no acknowledgement, so a freeze never passes on one.
  if (schema.field['ok'] !== undefined && Reflect.get(message, 'ok') !== true) {
    throw new Error(`${schema.typeName}: the agent did not acknowledge the op`);
  }

  const bad = findBadCount(schema, message);

  if (bad !== undefined) {
    throw new Error(`${bad}: the agent sent a number out of its range`);
  }

  return message;
}

// A double's protobuf JSON form reads "NaN", "Infinity", fractions and negatives, and impd puts
// these counts in log bounds and file metadata.
function findBadCount(schema: DescMessage, message: object): string | undefined {
  for (const field of schema.fields) {
    const value: unknown = Reflect.get(message, field.localName);
    const items: unknown[] = Array.isArray(value) ? value : [value];

    for (const item of items) {
      const bad = findBadFieldValue(field, item);

      if (bad !== undefined) {
        return bad;
      }
    }
  }

  return undefined;
}

const NON_COUNT_FIELDS = new Set(['imp.agent.v1.Activity.load1']);

function findBadFieldValue(field: DescField, value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && field.message !== undefined) {
    return findBadCount(field.message, value);
  }

  if (typeof value !== 'number' || field.scalar !== ScalarType.DOUBLE) {
    return undefined;
  }

  const name = `${field.parent.typeName}.${field.name}`;

  const isGood = NON_COUNT_FIELDS.has(name)
    ? Number.isFinite(value)
    : Number.isSafeInteger(value) && value >= 0;

  return isGood ? undefined : name;
}
