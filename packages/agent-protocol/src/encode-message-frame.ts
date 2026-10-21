import { create, toJson } from '@bufbuild/protobuf';
import type { DescMessage, MessageInitShape } from '@bufbuild/protobuf';
import { encodeJsonFrame } from './frame-codec';
import type { FrameType } from './frame-codec';

export function encodeMessageFrame<Desc extends DescMessage>(
  type: FrameType,
  schema: Desc,
  message: MessageInitShape<Desc>,
): Uint8Array {
  // The Go agent marshals with protojson's EmitDefaultValues, so a frame in the agent's voice
  // carries every field the schema does not mark optional, zero or not.
  const json = toJson(schema, create(schema, message), {
    useProtoFieldName: true,
    alwaysEmitImplicit: true,
  });

  return encodeJsonFrame(type, json);
}
