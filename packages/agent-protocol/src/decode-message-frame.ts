import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { decodeAgentMessage } from './decode-agent-message';
import { decodeJsonPayload } from './frame-codec';
import type { AgentFrame } from './frame-codec';

export function decodeMessageFrame<Desc extends DescMessage>(
  schema: Desc,
  frame: AgentFrame,
): MessageShape<Desc> {
  return decodeAgentMessage(schema, decodeJsonPayload(frame));
}
