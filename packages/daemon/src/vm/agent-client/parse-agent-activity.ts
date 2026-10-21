import type { JsonValue } from '@bufbuild/protobuf';
import { ActivitySchema, SessionInfoSchema } from './agent-protocol';
import type { Activity, SessionInfo } from './agent-protocol';
import { decodeAgentMessage } from './decode-agent-message';
import { hasAgentNameForms } from './has-agent-name-forms';
import { isAgentSessionState } from './is-agent-session-state';

export function parseAgentActivity(json: JsonValue): Activity {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return decodeAgentMessage(ActivitySchema, json);
  }

  const { sessions, ...counts } = json;
  const activity = decodeAgentMessage(ActivitySchema, counts);

  // A bad session is dropped rather than the whole answer, because the watchdog reads any answer as
  // a sign of life.
  activity.sessions = Array.isArray(sessions)
    ? sessions.flatMap((entry) => parseSession(entry))
    : [];

  return activity;
}

function parseSession(entry: JsonValue): SessionInfo[] {
  try {
    const session = decodeAgentMessage(SessionInfoSchema, entry);

    return hasAgentNameForms(session) && isAgentSessionState(session.state) ? [session] : [];
  } catch {
    return [];
  }
}
