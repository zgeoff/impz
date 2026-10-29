import invariant from 'tiny-invariant';
import type { RamAdmission } from '../../vm/imps-contract/ram-admission';
import type { RamGovernor } from './ram-governor';

type AdmittingGovernor = Pick<RamGovernor, 'admit' | 'release' | 'admitGrow' | 'releaseGrow'>;

export interface DeferredAdmission {
  readonly admission: RamAdmission;
  readonly admitGrow: RamGovernor['admitGrow'];
  readonly releaseGrow: RamGovernor['releaseGrow'];
  readonly attach: (governor: AdmittingGovernor) => void;
}

// The governor reads the imp service it admits boots for, so the service takes this
// admission first and the governor attaches once both exist.
export function buildDeferredAdmission(): DeferredAdmission {
  const holder: { governor: AdmittingGovernor | null } = { governor: null };

  const requireGovernor = (): AdmittingGovernor => {
    invariant(holder.governor, 'RAM admission ran before the RAM governor was attached');

    return holder.governor;
  };

  return {
    admission: {
      admit: (request) => requireGovernor().admit(request),
      release: (id) => {
        requireGovernor().release(id);
      },
    },
    admitGrow: (request) => requireGovernor().admitGrow(request),
    releaseGrow: (id) => {
      requireGovernor().releaseGrow(id);
    },
    attach: (governor) => {
      holder.governor = governor;
    },
  };
}
