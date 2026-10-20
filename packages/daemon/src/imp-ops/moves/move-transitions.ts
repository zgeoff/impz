import type { MoveState } from '@impz/api';

// A move's mark on an imp row, as from → to: the source's `sending`, then
// `moved` at the receipt, either cleared by an abort; the target's copy goes
// in `receiving`, cleared by the commit. updateImpMove does not check it yet.
export const MOVE_TRANSITIONS: readonly (readonly [MoveState | null, MoveState | null])[] = [
  [null, 'sending'],
  ['sending', null],
  ['sending', 'moved'],
  ['moved', null],
  [null, 'receiving'],
  ['receiving', null],
];
