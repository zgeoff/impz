import type { ImpRecord } from '../../../platform/db/imps';
import { readSnapshotMeta } from '../../../vm/sleep/snapshot-meta';
import type { ImpContext } from '../imp-context';

type SessionSources = Pick<ImpContext, 'sessions' | 'findPaths'>;

export function readSeenSessions(context: SessionSources, imp: Readonly<ImpRecord>) {
  if (imp.state === 'running') {
    return context.sessions.read(imp.id);
  }

  if (imp.state === 'sleeping') {
    return readSnapshotMeta(context.findPaths(imp.id))?.sessions;
  }

  return [];
}

export function countSessions(
  context: SessionSources,
  imp: Readonly<ImpRecord>,
): number | undefined {
  return readSeenSessions(context, imp)?.length;
}
