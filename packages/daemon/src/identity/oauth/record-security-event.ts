import type { SecurityEvent } from '@zgeoff/mcp-auth';
import { getImpdLogger } from '../../platform/process/get-impd-logger';

export function recordSecurityEvent(event: SecurityEvent): void {
  const fields = {
    kind: event.kind,
    outcome: event.outcome,
    reason: event.reason ?? '-',
    path: event.path,
    client: event.client?.name ?? '-',
  };

  const isRefusal = event.outcome === 'rejected' || event.outcome === 'failed';
  const log = getImpdLogger('oauth');

  if (isRefusal) {
    log.warning('{kind} {outcome} ({reason}) at {path} for {client}', fields);
  } else {
    log.info('{kind} {outcome} at {path} for {client}', fields);
  }
}
