export interface LockAdmission {
  readonly heldBytes: number;
  readonly lockBytes: number;
  readonly ramBudgetMib: number;
}

// No sleep frees a locked page, so the locks keep to a share of the RAM budget that leaves the
// imps room to boot and grow on a small host.
const MAX_LOCKED_PERCENT = 10;
const MIB = 1024 * 1024;

export function canAdmitLock(admission: Readonly<LockAdmission>): boolean {
  const maxLockedBytes = Math.floor((admission.ramBudgetMib * MAX_LOCKED_PERCENT) / 100) * MIB;

  return admission.heldBytes + admission.lockBytes <= maxLockedBytes;
}
