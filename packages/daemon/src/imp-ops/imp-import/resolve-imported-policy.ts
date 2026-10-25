import type { EgressPolicy } from '@impz/api';
import { parseEgressPolicy } from '../../platform/db/parse-egress-policy';

interface ImportedPolicy {
  readonly mode: string;
  readonly allow: unknown;
  readonly onUnknown: (mode: string) => void;
}

export function resolveImportedPolicy(imported: ImportedPolicy): EgressPolicy {
  const policy = parseEgressPolicy(imported.mode, imported.allow);

  if (policy !== null) {
    return policy;
  }

  imported.onUnknown(imported.mode);

  return { mode: 'none', allow: [] };
}
