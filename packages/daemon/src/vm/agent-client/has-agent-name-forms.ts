import { isMessage } from '@bufbuild/protobuf';
import type { Message } from '@bufbuild/protobuf';
import { AgentBootIdSchema, AgentGenerationSchema, AgentSessionNameSchema } from './agent-ids';

export function hasAgentNameForms(message: Message): boolean {
  return Object.entries(message).every(([key, value]) =>
    hasFieldForm(message.$typeName, key, value),
  );
}

const SESSION_NAME_FIELDS = new Set([
  'imp.agent.v1.SessionInfo.name',
  'imp.agent.v1.Started.session',
]);

function hasFieldForm(typeName: string, key: string, value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (key === 'executionGeneration') {
    // Agents from before session offsets list a session with an empty generation.
    return (
      (value === '' && typeName === 'imp.agent.v1.SessionInfo') ||
      AgentGenerationSchema.safeParse(value).success
    );
  }

  if (key === 'bootId') {
    return AgentBootIdSchema.safeParse(value).success;
  }

  if (SESSION_NAME_FIELDS.has(`${typeName}.${key}`)) {
    return AgentSessionNameSchema.safeParse(value).success;
  }

  if (Array.isArray(value)) {
    return value.every((item) => !isMessage(item) || hasAgentNameForms(item));
  }

  return !isMessage(value) || hasAgentNameForms(value);
}
