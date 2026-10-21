import { probeBrokerSession, writeBrokerSession } from '../../platform/db/broker-sessions';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { SessionInfo } from '../../vm/agent-client/agent-protocol';
import type { ExecStream } from '../../vm/agent-client/exec-stream';
import { buildBrokerNotReadyError } from './exec-require';

export async function checkBrokerAttach(
  db: ImpDatabase,
  impId: string,
  name: string,
  resumeGeneration: string | undefined,
  sessions: readonly SessionInfo[],
): Promise<Error | null> {
  const attached = sessions.filter(
    (session) =>
      session.name === name &&
      (session.state === 'running' ||
        (resumeGeneration !== undefined && session.executionGeneration === resumeGeneration)),
  );

  for (const session of attached) {
    const generation = session.executionGeneration === '' ? undefined : session.executionGeneration;

    const refused = await checkCoverage(db, impId, generation, name);

    if (refused !== null) {
      return refused;
    }
  }

  return null;
}

export async function checkOpenedSession(
  db: ImpDatabase,
  impId: string,
  name: string,
  stream: Pick<ExecStream, 'created' | 'output'>,
  sessions: readonly SessionInfo[],
): Promise<Error | null> {
  const output = stream.output;
  const generation = output?.continuity === 'offsets' ? output.executionGeneration : undefined;

  if (!stream.created) {
    return checkCoverage(db, impId, generation, name);
  }

  if (generation !== undefined) {
    // The agent keeps an exited run listed while a resume can still attach to it.
    const listed = sessions.flatMap((session) =>
      session.executionGeneration === '' ? [] : [session.executionGeneration],
    );

    await writeBrokerSession(db, impId, generation, listed);
  }

  return null;
}

async function checkCoverage(
  db: ImpDatabase,
  impId: string,
  generation: string | undefined,
  name: string,
): Promise<Error | null> {
  const isRecorded =
    generation === undefined ? false : await probeBrokerSession(db, impId, generation);

  return isRecorded
    ? null
    : buildBrokerNotReadyError(`session ${name} was started without the broker requirement`);
}
