import { create, toJson } from '@bufbuild/protobuf';
import type { DescMessage, JsonValue, MessageInitShape } from '@bufbuild/protobuf';

export function encodeAgentMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageInitShape<Desc>,
): JsonValue {
  return toJson(schema, create(schema, message), { useProtoFieldName: true });
}
