import { isImpAllowed } from '@impz/api';
import type { AdmissionRequest } from '../../vm/imps-contract/ram-admission';
import type { PriorityRam } from '../../vm/vm-config';

interface NamedImp {
  readonly id: string;
  readonly name: string;
}

export interface PriorityAdmissions {
  readonly isPriority: (name: string | null) => boolean;
  readonly isPriorityRequest: (request: Readonly<AdmissionRequest>) => boolean;
  readonly isPriorityImp: (imp: Readonly<NamedImp>) => boolean;
  readonly isAdmitted: (id: string) => boolean;
  readonly recordAdmission: (request: Readonly<AdmissionRequest>) => void;
  readonly release: (id: string) => void;
}

export function createPriorityAdmissions(priority: PriorityRam | null): PriorityAdmissions {
  // the admitted priority imps, whose reservations, pool pages and RAM count against the kept RAM
  // until each is released
  const admitted = new Set<string>();

  const isPriority = (name: string | null): boolean =>
    priority !== null && name !== null && isImpAllowed(priority.patterns, name);

  const isPriorityRequest = (request: Readonly<AdmissionRequest>): boolean =>
    isPriority(request.priorityName ?? request.name);

  return {
    isPriority,
    isPriorityRequest,
    isPriorityImp: (imp) => admitted.has(imp.id) || isPriority(imp.name),
    isAdmitted: (id) => admitted.has(id),
    recordAdmission: (request) => {
      if (isPriorityRequest(request)) {
        admitted.add(request.id);
      } else {
        admitted.delete(request.id);
      }
    },
    release: (id) => {
      admitted.delete(id);
    },
  };
}
