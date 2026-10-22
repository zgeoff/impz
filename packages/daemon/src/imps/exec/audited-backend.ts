import { EVENT_VERSION } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 moves the caller into platform
import type { AuditActor } from '../../identity/auth/caller';
import { withAuditedOpen } from '../../platform/audit/api-audit';
import type { ApiAudit } from '../../platform/audit/api-audit';
import type { EventBus } from '../../platform/events/event-bus';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import type { AgentExecRequest } from '../../vm/agent-client/exec-stream';
import type { ExecBackend } from './exec-session';

export function buildAuditedBackend(
  backend: ExecBackend,
  audit: ApiAudit,
  actor: AuditActor,
  events: EventBus,
  now: () => number,
): ExecBackend {
  const buildCall = (procedure: string, name: string) => ({
    procedure,
    actor,
    impName: name,
    startedAt: now(),
  });

  return {
    openExec: async (name, request, feature) => {
      const procedure = readProcedure(request, feature);

      const stream = await withAuditedOpen(audit, buildCall(procedure, name), () =>
        backend.openExec(name, request, feature),
      );

      if (request.outer === true) {
        events.publish({
          // oxlint-disable-next-line id-length -- `v` is the event format's version field
          v: EVENT_VERSION,
          at: new Date(now()),
          ev: 'AgentExec',
          name,
          actor: actor.kind,
          actorName: actor.name,
          tty: request.tty,
          command: request.argv[0] ?? '',
        });
      }

      return stream;
    },
    openAttach: (name, request) =>
      withAuditedOpen(audit, buildCall('attach', name), () => backend.openAttach(name, request)),
    recordActivity: (name) => backend.recordActivity(name),
  };
}

function readProcedure(request: AgentExecRequest, feature: AgentFeature | undefined): string {
  if (request.outer === true) {
    return 'exec-agent';
  }

  if (feature === 'cp') {
    return 'cp';
  }

  return request.tty ? 'console' : 'exec';
}
