import { ORPCError } from '@orpc/server';
import type { ExecBackend } from '../../src/imps/exec/exec-session';
import { buildInvalidStateError } from '../../src/surface/api-errors';
import type { AgentFeature } from '../../src/vm/agent-client/agent-outdated';
import type {
  AgentAttachRequest,
  AgentExecRequest,
  ExecStream,
} from '../../src/vm/agent-client/exec-stream';

type StubOpen =
  | {
      readonly kind: 'exec';
      readonly name: string;
      readonly request: AgentExecRequest;
      readonly feature: AgentFeature | undefined;
    }
  | { readonly kind: 'attach'; readonly name: string; readonly request: AgentAttachRequest };

interface StubExecBackendOptions {
  readonly exec?: ExecStream | Error;
  readonly attach?: ExecStream | Error;
}

export function buildStubExecBackend(options: StubExecBackendOptions = {}) {
  const opens: StubOpen[] = [];
  const activity: string[] = [];

  const backend: ExecBackend = {
    openExec: (name, request, feature) => {
      opens.push({ kind: 'exec', name, request, feature });

      return openOutcome(options.exec);
    },
    openAttach: (name, request) => {
      opens.push({ kind: 'attach', name, request });

      return openOutcome(options.attach);
    },
    recordActivity: (name) => {
      activity.push(name);

      return Promise.resolve();
    },
  };

  return { backend, opens, activity };
}

function openOutcome(outcome: ExecStream | Error | undefined): Promise<ExecStream> {
  // the refusal a stopped imp's attach gets with no cold boots on record; the real service
  // boots a stopped imp for an exec, so there this stands for any typed refusal
  if (outcome === undefined) {
    const refused = buildInvalidStateError('stopped', ['running'], 'attach without a wake to');

    return Promise.reject(
      new ORPCError('INVALID_STATE', {
        status: refused.status,
        message: refused.message,
        data: { ...refused.data, coldBoots: [] },
      }),
    );
  }

  return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
}
