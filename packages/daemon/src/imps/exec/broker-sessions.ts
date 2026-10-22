import type { SessionInfo } from '@impz/agent-protocol';
import { probeBrokerSession, writeBrokerSession } from '../../platform/db/broker-sessions';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { ExecStream } from '../../vm/agent-client/exec-stream';
import { buildBrokerNotReadyError } from './exec-require';

interface CheckBrokerAttachOptions {
  readonly impId: string;
  readonly name: string;
  readonly resumeGeneration: string | undefined;
  readonly sessions: readonly SessionInfo[];
}

export async function checkBrokerAttach(
  db: ImpDatabase,
  options: CheckBrokerAttachOptions,
): Promise<Error | null> {
  const impId = options.impId;
  const name = options.name;
  const resumeGeneration = options.resumeGeneration;

  const attached = options.sessions.filter(
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

interface CheckOpenedSessionOptions {
  readonly impId: string;
  readonly name: string;
  readonly stream: Pick<ExecStream, 'created' | 'output'>;
  readonly sessions: readonly SessionInfo[];
}

export async function checkOpenedSession(
  db: ImpDatabase,
  options: CheckOpenedSessionOptions,
): Promise<Error | null> {
  const impId = options.impId;
  const output = options.stream.output;
  const generation = output?.continuity === 'offsets' ? output.executionGeneration : undefined;

  if (!options.stream.created) {
    return checkCoverage(db, impId, generation, options.name);
  }

  if (generation !== undefined) {
    // The agent keeps an exited run listed while a resume can still attach to it.
    const listed = options.sessions.flatMap((session) =>
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
