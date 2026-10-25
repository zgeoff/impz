import type { EgressPolicy } from '@impz/api';
import { parseEgressPolicy } from '../../platform/db/parse-egress-policy';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { ImpdArea } from '../../platform/process/get-impd-logger';

interface ImportedPolicy {
  readonly area: ImpdArea;
  readonly impName: string;
  readonly mode: string;
  readonly allow: unknown;
}

export function resolveImportedPolicy(imported: ImportedPolicy): EgressPolicy {
  const policy = parseEgressPolicy(imported.mode, imported.allow);

  if (policy !== null) {
    return policy;
  }

  getImpdLogger(imported.area)
    .with({ imp: imported.impName })
    .warning('unknown egress policy {egressPolicy}; imported as none', {
      egressPolicy: JSON.stringify(imported.mode),
    });

  return { mode: 'none', allow: [] };
}
