import { AgentError } from '../agent-client/agent-connection';
import type { ExecStream } from '../agent-client/exec-stream';
import { isAgentError } from '../agent-client/is-agent-error';
import { listColdBoots } from '../db/cold-boots';
import type { ImpRecord } from '../db/imps';
import type { ImpHost } from './imp-context';

// A session's output, and NO_SESSION, name the imp's cold boots, read after
// any boot the open caused, so that boot comes first
export async function withColdBoots(
  context: ImpHost,
  imp: ImpRecord,
  opening: Promise<ExecStream>,
): Promise<ExecStream> {
  let stream: ExecStream;

  try {
    stream = await opening;
  } catch (error) {
    if (isAgentError(error, 'NO_SESSION') && isRecord(error.data)) {
      const coldBoots = await listColdBoots(context.db, imp.id);

      throw new AgentError(error.code, error.detail, { ...error.data, coldBoots });
    }

    throw error;
  }

  const output = stream.output;

  if (output?.continuity !== 'offsets') {
    return stream;
  }

  const coldBoots = await listColdBoots(context.db, imp.id).catch((error: unknown) => {
    stream.close();
    throw error;
  });

  return { ...stream, output: { ...output, coldBoots } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
