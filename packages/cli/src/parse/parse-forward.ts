import { UsageError } from '../cli/errors';

export interface Forward {
  readonly local: number;
  readonly remote: number;
}

const MAX_PORT = 65_535;

export function parseForward(spec: string): Forward {
  const match = /^(?:(?<local>\d+):)?(?<remote>\d+)$/u.exec(spec);
  const remote = Number(match?.groups?.['remote']);
  const localText = match?.groups?.['local'];
  const local = localText === undefined ? remote : Number(localText);

  if (match === null || remote < 1 || remote > MAX_PORT || local > MAX_PORT) {
    throw new UsageError(`not a port: ${spec} (try 5432, or local:remote such as 15432:5432)`);
  }

  return { local, remote };
}
