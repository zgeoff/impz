import type { ResumeFrom } from '@impz/api';
import type { ExecStream } from '../../src/vm/agent-client/exec-stream';

interface TapCall {
  readonly session: string;
  readonly resumeFrom: ResumeFrom | undefined;
}

export function buildStubTapOpener() {
  const calls: TapCall[] = [];
  const answers: (() => Promise<ExecStream>)[] = [];

  return {
    calls,
    answers,
    openTap: (_vsockPath: string, session: string, resumeFrom?: ResumeFrom) => {
      calls.push({ session, resumeFrom });

      const answer = answers.shift() ?? (() => Promise.reject(new Error('no tap queued')));

      return answer();
    },
  };
}
